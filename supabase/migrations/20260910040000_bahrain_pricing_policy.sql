-- Server-authoritative Bahrain supermarket pricing policy.
-- Policy changes never mutate product prices automatically. Explicit application
-- reuses the canonical product selling-price command introduced by PR #24.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.categories'::regclass
      AND conname = 'categories_tenant_id_id_key'
  ) THEN
    ALTER TABLE public.categories
      ADD CONSTRAINT categories_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END
$$;

CREATE TABLE public.pricing_policy_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  branch_id uuid,
  category_id uuid,
  product_id uuid,
  markup_basis_points integer NOT NULL CHECK (markup_basis_points >= 0 AND markup_basis_points <= 1000000),
  rounding_increment_fils bigint NOT NULL CHECK (rounding_increment_fils = 25),
  rounding_mode text NOT NULL CHECK (rounding_mode IN ('nearest_half_up','ceil')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  changed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  operation_id text NOT NULL CHECK (length(btrim(operation_id)) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_policy_rules_scope_check CHECK (
    NOT (category_id IS NOT NULL AND product_id IS NOT NULL)
  ),
  CONSTRAINT pricing_policy_rules_interval_check CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT pricing_policy_rules_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id) REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pricing_policy_rules_tenant_category_fkey
    FOREIGN KEY (tenant_id, category_id) REFERENCES public.categories(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pricing_policy_rules_tenant_product_fkey
    FOREIGN KEY (tenant_id, product_id) REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pricing_policy_rules_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX pricing_policy_rules_current_tenant_key
ON public.pricing_policy_rules(tenant_id)
WHERE effective_to IS NULL AND branch_id IS NULL AND category_id IS NULL AND product_id IS NULL;

CREATE UNIQUE INDEX pricing_policy_rules_current_branch_key
ON public.pricing_policy_rules(tenant_id, branch_id)
WHERE effective_to IS NULL AND branch_id IS NOT NULL AND category_id IS NULL AND product_id IS NULL;

CREATE UNIQUE INDEX pricing_policy_rules_current_category_key
ON public.pricing_policy_rules(tenant_id, category_id)
WHERE effective_to IS NULL AND branch_id IS NULL AND category_id IS NOT NULL AND product_id IS NULL;

CREATE UNIQUE INDEX pricing_policy_rules_current_branch_category_key
ON public.pricing_policy_rules(tenant_id, branch_id, category_id)
WHERE effective_to IS NULL AND branch_id IS NOT NULL AND category_id IS NOT NULL AND product_id IS NULL;

CREATE UNIQUE INDEX pricing_policy_rules_current_product_key
ON public.pricing_policy_rules(tenant_id, product_id)
WHERE effective_to IS NULL AND branch_id IS NULL AND category_id IS NULL AND product_id IS NOT NULL;

CREATE UNIQUE INDEX pricing_policy_rules_current_branch_product_key
ON public.pricing_policy_rules(tenant_id, branch_id, product_id)
WHERE effective_to IS NULL AND branch_id IS NOT NULL AND category_id IS NULL AND product_id IS NOT NULL;

CREATE INDEX pricing_policy_rules_lookup_idx
ON public.pricing_policy_rules(tenant_id, product_id, category_id, branch_id, effective_from DESC)
WHERE effective_to IS NULL;

CREATE TABLE public.pricing_policy_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (length(btrim(operation_id)) BETWEEN 8 AND 200),
  operation_kind text NOT NULL CHECK (operation_kind IN ('set_rule','deactivate_rule','apply','apply_batch')),
  request_hash text NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  rule_id uuid,
  product_id uuid,
  result jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_policy_operations_tenant_operation_key UNIQUE (tenant_id, operation_id),
  CONSTRAINT pricing_policy_operations_tenant_rule_fkey
    FOREIGN KEY (tenant_id, rule_id) REFERENCES public.pricing_policy_rules(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pricing_policy_operations_tenant_product_fkey
    FOREIGN KEY (tenant_id, product_id) REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX pricing_policy_operations_tenant_created_idx
ON public.pricing_policy_operations(tenant_id, created_at DESC);

ALTER TABLE public.pricing_policy_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_policy_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY pricing_policy_rules_manager_read
ON public.pricing_policy_rules
FOR SELECT TO authenticated
USING (
  (
    branch_id IS NULL
    AND public.has_any_role(
      auth.uid(), tenant_id,
      ARRAY['owner','admin','manager']::public.app_role[]
    )
  )
  OR (
    branch_id IS NOT NULL
    AND public.has_branch_role(
      auth.uid(), tenant_id, branch_id,
      ARRAY['owner','admin','manager']::public.app_role[]
    )
  )
);

REVOKE ALL ON public.pricing_policy_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.pricing_policy_rules TO authenticated;
REVOKE ALL ON public.pricing_policy_operations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.can_manage_pricing_scope_internal_v1(
  _actor_id uuid,
  _tenant_id uuid,
  _branch_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN _actor_id IS NULL THEN false
    WHEN _branch_id IS NULL THEN EXISTS (
      SELECT 1 FROM public.user_roles role_row
      WHERE role_row.user_id = _actor_id
        AND role_row.tenant_id = _tenant_id
        AND role_row.branch_id IS NULL
        AND role_row.role = ANY(ARRAY['owner','admin','manager']::public.app_role[])
    )
    ELSE EXISTS (
      SELECT 1 FROM public.user_roles role_row
      WHERE role_row.user_id = _actor_id
        AND role_row.tenant_id = _tenant_id
        AND role_row.role = ANY(ARRAY['owner','admin','manager']::public.app_role[])
        AND (role_row.branch_id IS NULL OR role_row.branch_id = _branch_id)
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.can_manage_pricing_scope_internal_v1(uuid,uuid,uuid)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.calculate_bahrain_retail_price_v1(
  _cost_fils bigint,
  _markup_basis_points integer,
  _rounding_increment_fils bigint,
  _rounding_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  _raw_numerator numeric;
  _raw_denominator numeric := 10000;
  _bucket_denominator numeric;
  _rounded_units numeric;
  _rounded_fils numeric;
BEGIN
  IF _cost_fils IS NULL OR _cost_fils < 0 THEN
    RAISE EXCEPTION 'Cost must be a nonnegative exact-fils value';
  END IF;
  IF _markup_basis_points IS NULL OR _markup_basis_points < 0 OR _markup_basis_points > 1000000 THEN
    RAISE EXCEPTION 'Markup basis points are invalid';
  END IF;
  IF _rounding_increment_fils IS NULL OR _rounding_increment_fils <> 25 THEN
    RAISE EXCEPTION 'Bahrain retail rounding increment must be 25 fils';
  END IF;
  IF _rounding_mode IS NULL OR _rounding_mode NOT IN ('nearest_half_up','ceil') THEN
    RAISE EXCEPTION 'Unsupported Bahrain retail rounding mode';
  END IF;

  _raw_numerator := _cost_fils::numeric * (10000::numeric + _markup_basis_points::numeric);
  _bucket_denominator := _raw_denominator * _rounding_increment_fils::numeric;

  IF _rounding_mode = 'nearest_half_up' THEN
    _rounded_units := floor((_raw_numerator + (_bucket_denominator / 2)) / _bucket_denominator);
  ELSE
    _rounded_units := ceil(_raw_numerator / _bucket_denominator);
  END IF;
  _rounded_fils := _rounded_units * _rounding_increment_fils::numeric;

  IF _rounded_fils > 9223372036854775807::numeric THEN
    RAISE EXCEPTION 'Calculated retail price exceeds exact-fils range';
  END IF;

  RETURN jsonb_build_object(
    'cost_fils', _cost_fils::text,
    'markup_basis_points', _markup_basis_points,
    'raw_price_numerator', _raw_numerator::text,
    'raw_price_denominator', _raw_denominator::text,
    'rounding_adjustment_numerator', (_rounded_fils * _raw_denominator - _raw_numerator)::text,
    'rounding_increment_fils', _rounding_increment_fils,
    'rounding_mode', _rounding_mode,
    'rounded_price_fils', _rounded_fils::bigint::text
  );
END
$$;

REVOKE ALL ON FUNCTION public.calculate_bahrain_retail_price_v1(bigint,integer,bigint,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_bahrain_retail_price_v1(bigint,integer,bigint,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_pricing_policy_operation_internal_v1(
  _tenant_id uuid,
  _operation_id text,
  _operation_kind text,
  _request_hash text,
  _actor_id uuid,
  _rule_id uuid,
  _product_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _inserted integer;
  _existing public.pricing_policy_operations;
BEGIN
  INSERT INTO public.pricing_policy_operations(
    tenant_id, operation_id, operation_kind, request_hash,
    actor_id, rule_id, product_id
  ) VALUES (
    _tenant_id, _operation_id, _operation_kind, _request_hash,
    _actor_id, _rule_id, _product_id
  )
  ON CONFLICT (tenant_id, operation_id) DO NOTHING;
  GET DIAGNOSTICS _inserted = ROW_COUNT;

  IF _inserted = 1 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO _existing
  FROM public.pricing_policy_operations
  WHERE tenant_id = _tenant_id AND operation_id = _operation_id
  FOR UPDATE;

  IF _existing.operation_kind <> _operation_kind
    OR _existing.request_hash <> _request_hash
    OR _existing.rule_id IS DISTINCT FROM _rule_id
    OR _existing.product_id IS DISTINCT FROM _product_id
  THEN
    RAISE EXCEPTION 'Pricing operation ID was already used with different input';
  END IF;
  IF _existing.completed_at IS NULL OR _existing.result IS NULL THEN
    RAISE EXCEPTION 'Pricing operation did not complete';
  END IF;
  RETURN _existing.result;
END
$$;

REVOKE ALL ON FUNCTION public.claim_pricing_policy_operation_internal_v1(uuid,text,text,text,uuid,uuid,uuid)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.complete_pricing_policy_operation_internal_v1(
  _tenant_id uuid,
  _operation_id text,
  _rule_id uuid,
  _product_id uuid,
  _result jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.pricing_policy_operations
  SET rule_id = COALESCE(_rule_id, rule_id),
      product_id = COALESCE(_product_id, product_id),
      result = _result,
      completed_at = now()
  WHERE tenant_id = _tenant_id AND operation_id = _operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pricing operation evidence is missing';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.complete_pricing_policy_operation_internal_v1(uuid,text,uuid,uuid,jsonb)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_pricing_policy_rule_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _category_id uuid,
  _product_id uuid,
  _markup_basis_points integer,
  _rounding_increment_fils bigint,
  _rounding_mode text,
  _reason text,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _request_hash text;
  _replay jsonb;
  _rule_id uuid;
  _now timestamptz := now();
  _previous_rule jsonb;
BEGIN
  _reason := btrim(COALESCE(_reason, ''));
  _operation_id := btrim(COALESCE(_operation_id, ''));
  IF length(_reason) < 3 OR length(_reason) > 500 THEN
    RAISE EXCEPTION 'A pricing policy reason is required';
  END IF;
  IF length(_operation_id) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'A stable pricing policy operation ID is required';
  END IF;
  IF _category_id IS NOT NULL AND _product_id IS NOT NULL THEN
    RAISE EXCEPTION 'A pricing rule may target a category or product, not both';
  END IF;
  IF NOT public.can_manage_pricing_scope_internal_v1(_actor_id, _tenant_id, _branch_id) THEN
    RAISE EXCEPTION 'Pricing policy change is forbidden for this tenant or branch';
  END IF;
  IF _branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches WHERE tenant_id = _tenant_id AND id = _branch_id
  ) THEN
    RAISE EXCEPTION 'Branch does not belong to this tenant';
  END IF;
  IF _category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.categories WHERE tenant_id = _tenant_id AND id = _category_id
  ) THEN
    RAISE EXCEPTION 'Category does not belong to this tenant';
  END IF;
  IF _product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.products WHERE tenant_id = _tenant_id AND id = _product_id
  ) THEN
    RAISE EXCEPTION 'Product does not belong to this tenant';
  END IF;

  -- Validate exact calculation parameters before writing policy state.
  PERFORM pg_advisory_xact_lock(hashtextextended('pricing-policy:' || _tenant_id::text, 0));
  PERFORM public.calculate_bahrain_retail_price_v1(
    0, _markup_basis_points, _rounding_increment_fils, _rounding_mode
  );

  _request_hash := md5(jsonb_build_object(
    'branch_id', _branch_id,
    'category_id', _category_id,
    'product_id', _product_id,
    'markup_basis_points', _markup_basis_points,
    'rounding_increment_fils', _rounding_increment_fils,
    'rounding_mode', _rounding_mode,
    'reason', _reason
  )::text);

  _replay := public.claim_pricing_policy_operation_internal_v1(
    _tenant_id, _operation_id, 'set_rule', _request_hash,
    _actor_id, NULL, _product_id
  );
  IF _replay IS NOT NULL THEN
    RETURN (_replay->>'rule_id')::uuid;
  END IF;

  -- All policy mutations and applications share the advisory lock above.
  -- Avoid upgrading the tenant foreign-key lock held by operation insertion.
  _now := clock_timestamp();

  SELECT to_jsonb(r) INTO _previous_rule
  FROM public.pricing_policy_rules r
  WHERE tenant_id = _tenant_id
    AND branch_id IS NOT DISTINCT FROM _branch_id
    AND category_id IS NOT DISTINCT FROM _category_id
    AND product_id IS NOT DISTINCT FROM _product_id
    AND effective_to IS NULL;

  UPDATE public.pricing_policy_rules
  SET effective_to = GREATEST(_now, effective_from)
  WHERE tenant_id = _tenant_id
    AND branch_id IS NOT DISTINCT FROM _branch_id
    AND category_id IS NOT DISTINCT FROM _category_id
    AND product_id IS NOT DISTINCT FROM _product_id
    AND effective_to IS NULL;

  INSERT INTO public.pricing_policy_rules(
    tenant_id, branch_id, category_id, product_id,
    markup_basis_points, rounding_increment_fils, rounding_mode,
    effective_from, changed_by, reason, operation_id
  ) VALUES (
    _tenant_id, _branch_id, _category_id, _product_id,
    _markup_basis_points, _rounding_increment_fils, _rounding_mode,
    _now, _actor_id, _reason, _operation_id
  ) RETURNING id INTO _rule_id;

  PERFORM public.complete_pricing_policy_operation_internal_v1(
    _tenant_id, _operation_id, _rule_id, _product_id,
    jsonb_build_object('rule_id', _rule_id)
  );

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (
    _tenant_id, _actor_id, 'catalogue.pricing_policy_rule_set',
    'pricing_policy_rule', _rule_id,
    jsonb_build_object(
      'operation_id', _operation_id,
      'branch_id', _branch_id,
      'category_id', _category_id,
      'product_id', _product_id,
      'markup_basis_points', _markup_basis_points,
      'rounding_increment_fils', _rounding_increment_fils,
      'rounding_mode', _rounding_mode,
      'previous_rule', _previous_rule,
      'resulting_effective_from', _now,
      'reason', _reason
    )
  );

  RETURN _rule_id;
END
$$;

REVOKE ALL ON FUNCTION public.set_pricing_policy_rule_v1(uuid,uuid,uuid,uuid,integer,bigint,text,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_pricing_policy_rule_v1(uuid,uuid,uuid,uuid,integer,bigint,text,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.deactivate_pricing_policy_rule_v1(
  _tenant_id uuid,
  _rule_id uuid,
  _reason text,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _rule public.pricing_policy_rules;
  _request_hash text;
  _replay jsonb;
  _deactivated_at timestamptz;
BEGIN
  _reason := btrim(COALESCE(_reason, ''));
  _operation_id := btrim(COALESCE(_operation_id, ''));
  IF length(_reason) < 3 OR length(_reason) > 500 THEN
    RAISE EXCEPTION 'A pricing policy deactivation reason is required';
  END IF;
  IF length(_operation_id) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'A stable pricing policy operation ID is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pricing-policy:' || _tenant_id::text, 0));
  SELECT * INTO _rule
  FROM public.pricing_policy_rules
  WHERE tenant_id = _tenant_id AND id = _rule_id
  FOR UPDATE;
  IF _rule.id IS NULL THEN
    RAISE EXCEPTION 'Pricing policy rule does not belong to this tenant';
  END IF;
  IF NOT public.can_manage_pricing_scope_internal_v1(_actor_id, _tenant_id, _rule.branch_id) THEN
    RAISE EXCEPTION 'Pricing policy deactivation is forbidden for this tenant or branch';
  END IF;

  _request_hash := md5(jsonb_build_object(
    'rule_id', _rule_id,
    'reason', _reason
  )::text);
  _replay := public.claim_pricing_policy_operation_internal_v1(
    _tenant_id, _operation_id, 'deactivate_rule', _request_hash,
    _actor_id, _rule_id, _rule.product_id
  );
  IF _replay IS NOT NULL THEN
    RETURN (_replay->>'rule_id')::uuid;
  END IF;

  IF _rule.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'Pricing policy rule is already inactive';
  END IF;

  _deactivated_at := GREATEST(clock_timestamp(), _rule.effective_from);
  UPDATE public.pricing_policy_rules
  SET effective_to = _deactivated_at
  WHERE tenant_id = _tenant_id AND id = _rule_id;

  PERFORM public.complete_pricing_policy_operation_internal_v1(
    _tenant_id, _operation_id, _rule_id, _rule.product_id,
    jsonb_build_object('rule_id', _rule_id)
  );

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (
    _tenant_id, _actor_id, 'catalogue.pricing_policy_rule_deactivated',
    'pricing_policy_rule', _rule_id,
    jsonb_build_object('operation_id', _operation_id, 'reason', _reason,
      'branch_id', _rule.branch_id, 'category_id', _rule.category_id,
      'product_id', _rule.product_id, 'previous_effective_to', _rule.effective_to,
      'resulting_effective_to', _deactivated_at)
  );

  RETURN _rule_id;
END
$$;

REVOKE ALL ON FUNCTION public.deactivate_pricing_policy_rule_v1(uuid,uuid,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deactivate_pricing_policy_rule_v1(uuid,uuid,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.preview_product_pricing_v1(
  _tenant_id uuid,
  _product_id uuid,
  _branch_id uuid,
  _channel public.sales_channel
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _product public.products;
  _rule public.pricing_policy_rules;
  _rule_scope text;
  _cost_fils bigint;
  _cost_source text := 'product_base_cost';
  _cost_event_id uuid;
  _price_event_id uuid;
  _current_price_fils bigint;
  _calculation jsonb;
BEGIN
  IF NOT public.can_manage_pricing_scope_internal_v1(_actor_id, _tenant_id, _branch_id) THEN
    RAISE EXCEPTION 'Pricing preview is forbidden for this tenant or branch';
  END IF;
  IF _branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches WHERE tenant_id = _tenant_id AND id = _branch_id
  ) THEN
    RAISE EXCEPTION 'Branch does not belong to this tenant';
  END IF;

  SELECT * INTO _product
  FROM public.products
  WHERE tenant_id = _tenant_id AND id = _product_id;
  IF _product.id IS NULL THEN
    RAISE EXCEPTION 'Product does not belong to this tenant';
  END IF;
  IF _product.status <> 'active' THEN
    RAISE EXCEPTION 'Inactive product cannot be repriced';
  END IF;

  IF _branch_id IS NOT NULL THEN
    SELECT amount_fils, id INTO _cost_fils, _cost_event_id
    FROM public.product_prices
    WHERE tenant_id = _tenant_id
      AND product_id = _product_id
      AND price_type = 'cost'
      AND branch_id = _branch_id
      AND channel IS NULL
      AND effective_to IS NULL
    ORDER BY effective_from DESC, created_at DESC
    LIMIT 1;
    IF _cost_fils IS NOT NULL THEN
      _cost_source := 'branch_received_cost';
    END IF;
  END IF;
  _cost_fils := COALESCE(_cost_fils, _product.cost_fils);
  IF _cost_fils IS NULL OR _cost_fils <= 0 THEN
    RAISE EXCEPTION 'Product needs a positive exact-fils cost before repricing';
  END IF;
  IF _cost_event_id IS NULL THEN
    SELECT id INTO _cost_event_id FROM public.product_prices
    WHERE tenant_id = _tenant_id AND product_id = _product_id
      AND price_type = 'cost' AND branch_id IS NULL AND channel IS NULL
      AND effective_to IS NULL;
  END IF;

  IF _branch_id IS NULL THEN
    SELECT r.* INTO _rule
    FROM public.pricing_policy_rules r
    WHERE r.tenant_id = _tenant_id
      AND r.effective_to IS NULL
      AND r.branch_id IS NULL
      AND (r.category_id IS NULL OR r.category_id = _product.category_id)
      AND (r.product_id = _product_id OR r.product_id IS NULL)
    ORDER BY CASE WHEN r.product_id = _product_id THEN 1
      WHEN r.category_id = _product.category_id THEN 2 ELSE 3 END, r.effective_from DESC
    LIMIT 1;
  ELSE
    SELECT r.* INTO _rule
    FROM public.pricing_policy_rules r
    WHERE r.tenant_id = _tenant_id
      AND r.effective_to IS NULL
      AND (
        (r.product_id = _product_id AND r.category_id IS NULL AND (r.branch_id = _branch_id OR r.branch_id IS NULL))
        OR (_product.category_id IS NOT NULL AND r.category_id = _product.category_id AND r.product_id IS NULL AND (r.branch_id = _branch_id OR r.branch_id IS NULL))
        OR (r.branch_id = _branch_id AND r.category_id IS NULL AND r.product_id IS NULL)
        OR (r.branch_id IS NULL AND r.category_id IS NULL AND r.product_id IS NULL)
      )
    ORDER BY CASE
      WHEN r.product_id = _product_id AND r.branch_id = _branch_id THEN 1
      WHEN r.product_id = _product_id AND r.branch_id IS NULL THEN 2
      WHEN r.category_id = _product.category_id AND r.branch_id = _branch_id THEN 3
      WHEN r.category_id = _product.category_id AND r.branch_id IS NULL THEN 4
      WHEN r.branch_id = _branch_id AND r.category_id IS NULL AND r.product_id IS NULL THEN 5
      ELSE 6
    END, r.effective_from DESC
    LIMIT 1;
  END IF;

  _rule_scope := CASE
    WHEN _rule.product_id IS NOT NULL AND _rule.branch_id IS NOT NULL THEN 'product_branch'
    WHEN _rule.product_id IS NOT NULL THEN 'product'
    WHEN _rule.category_id IS NOT NULL AND _rule.branch_id IS NOT NULL THEN 'category_branch'
    WHEN _rule.category_id IS NOT NULL THEN 'category'
    WHEN _rule.branch_id IS NOT NULL THEN 'branch'
    ELSE 'tenant'
  END;

  IF _rule.id IS NULL THEN
    _rule_scope := 'system_default';
    _calculation := public.calculate_bahrain_retail_price_v1(
      _cost_fils, 3300, 25, 'nearest_half_up'
    );
  ELSE
    _calculation := public.calculate_bahrain_retail_price_v1(
      _cost_fils, _rule.markup_basis_points,
      _rule.rounding_increment_fils, _rule.rounding_mode
    );
  END IF;

  SELECT p.amount_fils, p.id INTO _current_price_fils, _price_event_id
  FROM public.product_prices p
  WHERE p.tenant_id = _tenant_id
    AND p.product_id = _product_id
    AND p.price_type = 'selling'
    AND p.effective_to IS NULL
    AND (
      (_channel IS NOT NULL AND _branch_id IS NOT NULL AND p.channel = _channel AND p.branch_id = _branch_id)
      OR (_channel IS NOT NULL AND p.channel = _channel AND p.branch_id IS NULL)
      OR (_branch_id IS NOT NULL AND p.channel IS NULL AND p.branch_id = _branch_id)
      OR (p.channel IS NULL AND p.branch_id IS NULL)
    )
  ORDER BY CASE
    WHEN _channel IS NOT NULL AND _branch_id IS NOT NULL AND p.channel = _channel AND p.branch_id = _branch_id THEN 1
    WHEN _channel IS NOT NULL AND p.channel = _channel AND p.branch_id IS NULL THEN 2
    WHEN _branch_id IS NOT NULL AND p.channel IS NULL AND p.branch_id = _branch_id THEN 3
    ELSE 4
  END
  LIMIT 1;
  _current_price_fils := COALESCE(_current_price_fils, _product.price_fils);

  RETURN _calculation || jsonb_build_object(
    'tenant_id', _tenant_id,
    'product_id', _product_id,
    'branch_id', _branch_id,
    'channel', _channel,
    'rule_id', _rule.id,
    'rule_scope', _rule_scope,
    'cost_source', _cost_source,
    'cost_event_id', _cost_event_id,
    'selling_price_event_id', _price_event_id,
    'category_id', _product.category_id,
    'previewed_by', _actor_id,
    'generated_at', transaction_timestamp(),
    'current_selling_price_fils', _current_price_fils::text
  );
END
$$;

REVOKE ALL ON FUNCTION public.preview_product_pricing_v1(uuid,uuid,uuid,public.sales_channel)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_product_pricing_v1(uuid,uuid,uuid,public.sales_channel)
TO authenticated;

CREATE OR REPLACE FUNCTION public.apply_product_pricing_policy_v1(
  _tenant_id uuid,
  _product_id uuid,
  _branch_id uuid,
  _channel public.sales_channel,
  _expected_cost_fils bigint,
  _reason text,
  _operation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _request_hash text;
  _replay jsonb;
  _preview jsonb;
  _actual_cost_fils bigint;
  _applied_price_fils bigint;
  _financial_operation_id text;
  _result jsonb;
BEGIN
  _reason := btrim(COALESCE(_reason, ''));
  _operation_id := btrim(COALESCE(_operation_id, ''));
  IF length(_reason) < 3 OR length(_reason) > 500 THEN
    RAISE EXCEPTION 'A pricing application reason is required';
  END IF;
  IF length(_operation_id) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'A stable pricing application operation ID is required';
  END IF;
  IF _expected_cost_fils IS NULL OR _expected_cost_fils < 0 THEN
    RAISE EXCEPTION 'Expected cost must be a nonnegative exact-fils value';
  END IF;
  IF NOT public.can_manage_pricing_scope_internal_v1(_actor_id, _tenant_id, _branch_id) THEN
    RAISE EXCEPTION 'Pricing application is forbidden for this tenant or branch';
  END IF;

  _request_hash := md5(jsonb_build_object(
    'product_id', _product_id,
    'branch_id', _branch_id,
    'channel', _channel,
    'expected_cost_fils', _expected_cost_fils,
    'reason', _reason
  )::text);

  _replay := public.claim_pricing_policy_operation_internal_v1(
    _tenant_id, _operation_id, 'apply', _request_hash,
    _actor_id, NULL, _product_id
  );
  IF _replay IS NOT NULL THEN
    RETURN _replay;
  END IF;

  -- Lock the product before previewing so the cost snapshot remains stable
  -- through the canonical selling-price mutation in this transaction.
  PERFORM 1 FROM public.products
  WHERE tenant_id = _tenant_id AND id = _product_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product does not belong to this tenant'; END IF;

  _preview := public.preview_product_pricing_v1(
    _tenant_id, _product_id, _branch_id, _channel
  );
  _actual_cost_fils := (_preview->>'cost_fils')::bigint;
  IF _actual_cost_fils <> _expected_cost_fils THEN
    RAISE EXCEPTION 'Stale pricing preview: product cost changed from % to % fils',
      _expected_cost_fils, _actual_cost_fils;
  END IF;

  _applied_price_fils := (_preview->>'rounded_price_fils')::bigint;
  _financial_operation_id := 'pricing-policy:' || _operation_id;

  PERFORM public.set_product_selling_price_v1(
    _tenant_id, _product_id, _branch_id, _channel,
    _applied_price_fils, _reason, _financial_operation_id
  );

  _result := _preview || jsonb_build_object(
    'applied_price_fils', _applied_price_fils::text,
    'pricing_operation_id', _operation_id,
    'financial_operation_id', _financial_operation_id
  );

  PERFORM public.complete_pricing_policy_operation_internal_v1(
    _tenant_id, _operation_id,
    CASE WHEN _preview->>'rule_id' IS NULL THEN NULL ELSE (_preview->>'rule_id')::uuid END,
    _product_id, _result
  );

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (
    _tenant_id, _actor_id, 'catalogue.pricing_policy_applied',
    'product', _product_id,
    jsonb_build_object(
      'operation_id', _operation_id,
      'financial_operation_id', _financial_operation_id,
      'branch_id', _branch_id,
      'channel', _channel,
      'expected_cost_fils', _expected_cost_fils,
      'applied_price_fils', _applied_price_fils,
      'rule_id', _preview->'rule_id',
      'rule_scope', _preview->'rule_scope',
      'reason', _reason
    )
  );

  RETURN _result;
END
$$;

REVOKE ALL ON FUNCTION public.apply_product_pricing_policy_v1(uuid,uuid,uuid,public.sales_channel,bigint,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_product_pricing_policy_v1(uuid,uuid,uuid,public.sales_channel,bigint,text,text)
TO authenticated;

COMMIT;
