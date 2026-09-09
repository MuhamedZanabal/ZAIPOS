-- P1 POS price overrides with explicit permission and manager approval evidence.

BEGIN;

CREATE TABLE public.role_permissions (
  role public.app_role NOT NULL,
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, permission)
);

INSERT INTO public.role_permissions(role, permission) VALUES
  ('owner', 'pos.price_override.request'),
  ('admin', 'pos.price_override.request'),
  ('manager', 'pos.price_override.request'),
  ('cashier', 'pos.price_override.request'),
  ('waiter', 'pos.price_override.request'),
  ('super_admin', 'pos.price_override.request'),
  ('owner', 'pos.price_override.approve'),
  ('admin', 'pos.price_override.approve'),
  ('manager', 'pos.price_override.approve'),
  ('super_admin', 'pos.price_override.approve')
ON CONFLICT DO NOTHING;

REVOKE ALL ON public.role_permissions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.has_branch_permission(
  _user_id uuid,
  _tenant_id uuid,
  _branch_id uuid,
  _permission text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT _user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.user_roles role_assignment
      JOIN public.role_permissions permission_grant
        ON permission_grant.role = role_assignment.role
       AND permission_grant.permission = _permission
      WHERE role_assignment.user_id = _user_id
        AND (
          role_assignment.role = 'super_admin'::public.app_role
          OR (
            role_assignment.tenant_id = _tenant_id
            AND (role_assignment.branch_id IS NULL OR role_assignment.branch_id = _branch_id)
          )
        )
    )
$$;

REVOKE ALL ON FUNCTION public.has_branch_permission(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_branch_permission(uuid, uuid, uuid, text) TO authenticated;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.products'::regclass
      AND conname = 'products_tenant_id_id_key'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END
$migration$;

CREATE TABLE public.price_override_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  channel public.sales_channel NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0 AND quantity = round(quantity, 3)),
  modifiers_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(modifiers_snapshot) = 'array'),
  original_unit_price_fils bigint NOT NULL CHECK (original_unit_price_fils >= 0),
  requested_unit_price_fils bigint NOT NULL CHECK (requested_unit_price_fils >= 0),
  request_reason text NOT NULL CHECK (length(trim(request_reason)) >= 3),
  decision_reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','consumed','expired')),
  request_client_mutation_id text NOT NULL CHECK (length(trim(request_client_mutation_id)) >= 8),
  decision_client_mutation_id text CHECK (decision_client_mutation_id IS NULL OR length(trim(decision_client_mutation_id)) >= 8),
  approved_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  consumed_at timestamptz,
  consumed_sale_id uuid REFERENCES public.sales(id) ON DELETE RESTRICT,
  consumed_sale_item_id uuid REFERENCES public.sale_items(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_override_requests_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id) REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_override_requests_tenant_product_fkey
    FOREIGN KEY (tenant_id, product_id) REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, request_client_mutation_id),
  UNIQUE (tenant_id, decision_client_mutation_id),
  CHECK (requested_by IS DISTINCT FROM approved_by),
  CHECK (
    (status = 'pending' AND approved_by IS NULL AND approved_at IS NULL AND consumed_at IS NULL AND consumed_sale_id IS NULL AND consumed_sale_item_id IS NULL)
    OR (status IN ('approved','rejected') AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND consumed_at IS NULL AND consumed_sale_id IS NULL AND consumed_sale_item_id IS NULL)
    OR (status = 'consumed' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND consumed_at IS NOT NULL AND consumed_sale_id IS NOT NULL AND consumed_sale_item_id IS NOT NULL)
    OR (status = 'expired' AND consumed_at IS NULL AND consumed_sale_id IS NULL AND consumed_sale_item_id IS NULL)
  )
);

CREATE INDEX idx_price_override_branch_status
  ON public.price_override_requests(tenant_id, branch_id, status, created_at DESC);
CREATE INDEX idx_price_override_requester
  ON public.price_override_requests(requested_by, created_at DESC);

ALTER TABLE public.price_override_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY price_override_requests_select
ON public.price_override_requests
FOR SELECT TO authenticated
USING (
  requested_by = auth.uid()
  OR public.has_branch_permission(auth.uid(), tenant_id, branch_id, 'pos.price_override.approve')
);

REVOKE ALL ON public.price_override_requests FROM PUBLIC, anon;
GRANT SELECT ON public.price_override_requests TO authenticated;

ALTER TABLE public.sale_items
  ADD COLUMN original_unit_price_fils bigint,
  ADD COLUMN price_override_request_id uuid REFERENCES public.price_override_requests(id) ON DELETE RESTRICT,
  ADD COLUMN price_override_reason text,
  ADD COLUMN price_override_approved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN price_override_approved_at timestamptz;

ALTER TABLE public.sale_items
  ADD CONSTRAINT sale_items_price_override_evidence_check CHECK (
    (price_override_request_id IS NULL AND price_override_reason IS NULL AND price_override_approved_by IS NULL AND price_override_approved_at IS NULL)
    OR
    (price_override_request_id IS NOT NULL AND original_unit_price_fils IS NOT NULL AND price_override_reason IS NOT NULL AND price_override_approved_by IS NOT NULL AND price_override_approved_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION public.request_price_override_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _product_id uuid,
  _channel public.sales_channel,
  _quantity numeric,
  _requested_unit_price_fils bigint,
  _reason text,
  _client_mutation_id text,
  _modifiers jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _request_id uuid;
  _existing public.price_override_requests;
  _base_price_fils bigint;
  _modifier_delta_fils bigint := 0;
  _modifier_requested integer;
  _modifier_valid integer;
  _original_unit_price_fils bigint;
BEGIN
  IF NOT public.has_branch_permission(_user_id, _tenant_id, _branch_id, 'pos.price_override.request') THEN
    RAISE EXCEPTION 'Price override request is forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id=_branch_id AND tenant_id=_tenant_id AND status='active') THEN
    RAISE EXCEPTION 'Branch is not active for this business';
  END IF;
  IF _quantity IS NULL OR _quantity <= 0 OR _quantity <> round(_quantity, 3) THEN
    RAISE EXCEPTION 'Price override quantity must be positive with at most three decimal places';
  END IF;
  IF _requested_unit_price_fils IS NULL OR _requested_unit_price_fils < 0 THEN
    RAISE EXCEPTION 'Requested unit price must be a non-negative integer number of fils';
  END IF;
  _reason := trim(COALESCE(_reason, ''));
  IF length(_reason) < 3 THEN RAISE EXCEPTION 'Price override reason is required'; END IF;
  _client_mutation_id := trim(COALESCE(_client_mutation_id, ''));
  IF length(_client_mutation_id) < 8 THEN RAISE EXCEPTION 'A stable request operation ID is required'; END IF;
  _modifiers := COALESCE(_modifiers, '[]'::jsonb);
  IF jsonb_typeof(_modifiers) <> 'array' THEN RAISE EXCEPTION 'Modifiers must be a JSON array'; END IF;

  SELECT COALESCE(
    (SELECT cp.price_fils FROM public.product_channel_prices cp WHERE cp.tenant_id=_tenant_id AND cp.product_id=p.id AND cp.branch_id=_branch_id AND cp.channel=_channel LIMIT 1),
    (SELECT cp.price_fils FROM public.product_channel_prices cp WHERE cp.tenant_id=_tenant_id AND cp.product_id=p.id AND cp.branch_id IS NULL AND cp.channel=_channel LIMIT 1),
    bp.local_price_fils,
    p.price_fils
  ) INTO _base_price_fils
  FROM public.products p
  LEFT JOIN public.branch_products bp ON bp.tenant_id=_tenant_id AND bp.branch_id=_branch_id AND bp.product_id=p.id
  WHERE p.id=_product_id AND p.tenant_id=_tenant_id AND p.status='active' AND COALESCE(bp.is_available,true);
  IF _base_price_fils IS NULL THEN RAISE EXCEPTION 'Product is unavailable for this branch'; END IF;

  _modifier_requested := jsonb_array_length(_modifiers);
  IF _modifier_requested > 0 THEN
    SELECT COALESCE(sum(public.bhd_numeric_to_fils(option.price_delta)),0), count(*)
      INTO _modifier_delta_fils, _modifier_valid
    FROM jsonb_array_elements(_modifiers) selected
    JOIN public.modifier_options option ON option.id=(selected->>'option_id')::uuid AND option.is_available=true
    JOIN public.modifier_groups modifier_group ON modifier_group.id=option.group_id
    WHERE modifier_group.tenant_id=_tenant_id AND modifier_group.product_id=_product_id;
    IF _modifier_valid <> _modifier_requested THEN RAISE EXCEPTION 'One or more product modifiers are invalid or unavailable'; END IF;
  END IF;
  _original_unit_price_fils := _base_price_fils + _modifier_delta_fils;

  INSERT INTO public.price_override_requests(
    tenant_id, branch_id, product_id, requested_by, channel, quantity,
    modifiers_snapshot, original_unit_price_fils, requested_unit_price_fils,
    request_reason, request_client_mutation_id
  ) VALUES (
    _tenant_id, _branch_id, _product_id, _user_id, _channel, _quantity,
    _modifiers, _original_unit_price_fils, _requested_unit_price_fils,
    _reason, _client_mutation_id
  )
  ON CONFLICT (tenant_id, request_client_mutation_id) DO NOTHING
  RETURNING id INTO _request_id;

  IF _request_id IS NULL THEN
    SELECT * INTO _existing FROM public.price_override_requests
    WHERE tenant_id=_tenant_id AND request_client_mutation_id=_client_mutation_id;
    IF NOT FOUND
       OR _existing.branch_id IS DISTINCT FROM _branch_id
       OR _existing.product_id IS DISTINCT FROM _product_id
       OR _existing.requested_by IS DISTINCT FROM _user_id
       OR _existing.channel IS DISTINCT FROM _channel
       OR _existing.quantity IS DISTINCT FROM _quantity
       OR _existing.modifiers_snapshot IS DISTINCT FROM _modifiers
       OR _existing.original_unit_price_fils IS DISTINCT FROM _original_unit_price_fils
       OR _existing.requested_unit_price_fils IS DISTINCT FROM _requested_unit_price_fils
       OR _existing.request_reason IS DISTINCT FROM _reason THEN
      RAISE EXCEPTION 'Price override operation ID conflicts with another request';
    END IF;
    RETURN _existing.id;
  END IF;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (_tenant_id,_user_id,'pos.price_override_requested','price_override_requests',_request_id,
    jsonb_build_object('branch_id',_branch_id,'product_id',_product_id,'channel',_channel,'quantity',_quantity,
      'original_unit_price_fils',_original_unit_price_fils,'requested_unit_price_fils',_requested_unit_price_fils,
      'reason',_reason,'client_mutation_id',_client_mutation_id));
  RETURN _request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.request_price_override_v1(uuid,uuid,uuid,public.sales_channel,numeric,bigint,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_price_override_v1(uuid,uuid,uuid,public.sales_channel,numeric,bigint,text,text,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.decide_price_override_v1(
  _request_id uuid,
  _approve boolean,
  _reason text,
  _client_mutation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _request public.price_override_requests;
  _target_status text := CASE WHEN _approve THEN 'approved' ELSE 'rejected' END;
BEGIN
  _reason := trim(COALESCE(_reason, ''));
  IF length(_reason) < 3 THEN RAISE EXCEPTION 'Manager decision reason is required'; END IF;
  _client_mutation_id := trim(COALESCE(_client_mutation_id, ''));
  IF length(_client_mutation_id) < 8 THEN RAISE EXCEPTION 'A stable decision operation ID is required'; END IF;

  SELECT * INTO _request FROM public.price_override_requests WHERE id=_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Price override request was not found'; END IF;
  IF NOT public.has_branch_permission(_user_id,_request.tenant_id,_request.branch_id,'pos.price_override.approve') THEN
    RAISE EXCEPTION 'Price override approval is forbidden';
  END IF;
  IF _request.requested_by = _user_id THEN RAISE EXCEPTION 'A requester cannot approve their own price override'; END IF;

  IF _request.decision_client_mutation_id = _client_mutation_id THEN
    IF _request.status <> _target_status OR _request.decision_reason IS DISTINCT FROM _reason OR _request.approved_by IS DISTINCT FROM _user_id THEN
      RAISE EXCEPTION 'Price override decision operation ID conflicts with another decision';
    END IF;
    RETURN _request.id;
  END IF;
  IF _request.status <> 'pending' THEN RAISE EXCEPTION 'Price override request is no longer pending'; END IF;
  IF _request.expires_at <= now() THEN
    UPDATE public.price_override_requests SET status='expired',updated_at=now() WHERE id=_request.id;
    RAISE EXCEPTION 'Price override request has expired';
  END IF;

  UPDATE public.price_override_requests
  SET status=_target_status, approved_by=_user_id, approved_at=now(),
      decision_reason=_reason, decision_client_mutation_id=_client_mutation_id, updated_at=now()
  WHERE id=_request.id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (_request.tenant_id,_user_id,
    CASE WHEN _approve THEN 'pos.price_override_approved' ELSE 'pos.price_override_rejected' END,
    'price_override_requests',_request.id,
    jsonb_build_object('branch_id',_request.branch_id,'product_id',_request.product_id,'requested_by',_request.requested_by,
      'original_unit_price_fils',_request.original_unit_price_fils,'requested_unit_price_fils',_request.requested_unit_price_fils,
      'reason',_reason,'client_mutation_id',_client_mutation_id));
  RETURN _request.id;
END;
$$;

REVOKE ALL ON FUNCTION public.decide_price_override_v1(uuid,boolean,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_price_override_v1(uuid,boolean,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_price_override_request_v1(_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _request public.price_override_requests;
BEGIN
  SELECT * INTO _request FROM public.price_override_requests WHERE id=_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Price override request was not found'; END IF;
  IF _request.requested_by <> auth.uid()
     AND NOT public.has_branch_permission(auth.uid(),_request.tenant_id,_request.branch_id,'pos.price_override.approve') THEN
    RAISE EXCEPTION 'Price override request is forbidden';
  END IF;
  RETURN to_jsonb(_request);
END;
$$;

REVOKE ALL ON FUNCTION public.get_price_override_request_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_price_override_request_v1(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_pending_price_overrides_v1(_branch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _tenant_id uuid;
  _result jsonb;
BEGIN
  SELECT tenant_id INTO _tenant_id FROM public.branches WHERE id=_branch_id AND status='active';
  IF _tenant_id IS NULL
     OR NOT public.has_branch_permission(auth.uid(),_tenant_id,_branch_id,'pos.price_override.approve') THEN
    RAISE EXCEPTION 'Price override approval list is forbidden';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', request.id,
    'product_id', request.product_id,
    'product_name', product.name,
    'quantity', request.quantity,
    'original_unit_price_fils', request.original_unit_price_fils,
    'requested_unit_price_fils', request.requested_unit_price_fils,
    'request_reason', request.request_reason,
    'requested_by', request.requested_by,
    'created_at', request.created_at,
    'expires_at', request.expires_at
  ) ORDER BY request.created_at), '[]'::jsonb)
  INTO _result
  FROM public.price_override_requests request
  JOIN public.products product ON product.id=request.product_id AND product.tenant_id=request.tenant_id
  WHERE request.tenant_id=_tenant_id AND request.branch_id=_branch_id
    AND request.status='pending' AND request.expires_at > now();
  RETURN _result;
END;
$$;

REVOKE ALL ON FUNCTION public.list_pending_price_overrides_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pending_price_overrides_v1(uuid) TO authenticated;

-- checkout_sale_v2 is replaced below so the same authoritative command atomically
-- validates and consumes approved override evidence.
CREATE OR REPLACE FUNCTION public.checkout_sale_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _items jsonb,
  _payments jsonb,
  _discount_total_fils bigint DEFAULT 0,
  _notes text DEFAULT NULL,
  _customer_id uuid DEFAULT NULL,
  _channel public.sales_channel DEFAULT 'pos',
  _tip_amount_fils bigint DEFAULT 0,
  _coupon_code text DEFAULT NULL,
  _client_mutation_id text DEFAULT NULL,
  _cash_session_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _session_id uuid;
  _sale_id uuid;
  _legacy_sale_id uuid;
  _operation_id uuid;
  _operation public.checkout_operations;
  _request_payload jsonb;
  _subtotal_fils bigint := 0;
  _tax_total_fils bigint := 0;
  _coupon_discount_fils bigint := 0;
  _total_fils bigint := 0;
  _payment_total_fils bigint := 0;
  _item jsonb;
  _pay jsonb;
  _quantity numeric;
  _line_discount_fils bigint;
  _unit_price_fils bigint;
  _authoritative_unit_price_fils bigint;
  _modifier_delta_fils bigint;
  _line_subtotal_fils bigint;
  _line_tax_fils bigint;
  _line_total_fils bigint;
  _payment_fils bigint;
  _product record;
  _override public.price_override_requests;
  _sale_item_id uuid;
  _component record;
  _coupon public.discount_codes;
  _points_config integer;
  _points_earned integer;
  _dev_mode boolean := false;
  _modifier_requested integer;
  _modifier_valid integer;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.has_branch_role(
    _user_id,
    _tenant_id,
    _branch_id,
    ARRAY['owner','admin','manager','cashier','waiter']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.branches
    WHERE id = _branch_id
      AND tenant_id = _tenant_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Branch is not active for this business';
  END IF;

  IF _items IS NULL OR jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Sale must contain at least one item';
  END IF;

  _payments := COALESCE(_payments, '[]'::jsonb);
  IF jsonb_typeof(_payments) <> 'array' THEN
    RAISE EXCEPTION 'Payments must be a JSON array';
  END IF;

  _client_mutation_id := NULLIF(trim(COALESCE(_client_mutation_id, '')), '');
  IF _client_mutation_id IS NULL OR length(_client_mutation_id) < 8 THEN
    RAISE EXCEPTION 'A stable client mutation ID is required for checkout';
  END IF;

  IF COALESCE(_discount_total_fils, 0) < 0 THEN
    RAISE EXCEPTION 'Discount cannot be negative';
  END IF;
  IF COALESCE(_tip_amount_fils, 0) < 0 THEN
    RAISE EXCEPTION 'Tip cannot be negative';
  END IF;

  _discount_total_fils := COALESCE(_discount_total_fils, 0);
  _tip_amount_fils := COALESCE(_tip_amount_fils, 0);

  _request_payload := jsonb_build_object(
    'tenant_id', _tenant_id,
    'branch_id', _branch_id,
    'items', _items,
    'payments', _payments,
    'discount_total_fils', _discount_total_fils,
    'notes', _notes,
    'customer_id', _customer_id,
    'channel', _channel::text,
    'tip_amount_fils', _tip_amount_fils,
    'coupon_code', NULLIF(upper(trim(COALESCE(_coupon_code, ''))), ''),
    'cash_session_id', _cash_session_id
  );

  -- Check a v2 operation before the legacy sale fallback. This ensures that a
  -- reused mutation ID with a different payload is rejected instead of silently
  -- returning the existing sale.
  SELECT * INTO _operation
  FROM public.checkout_operations
  WHERE tenant_id = _tenant_id
    AND client_mutation_id = _client_mutation_id
  FOR UPDATE;

  IF FOUND THEN
    IF _operation.request_payload IS DISTINCT FROM _request_payload THEN
      RAISE EXCEPTION 'Client mutation ID was already used for a different checkout request';
    END IF;
    IF _operation.status = 'completed' AND _operation.sale_id IS NOT NULL THEN
      RETURN _operation.sale_id;
    END IF;
    RAISE EXCEPTION 'Checkout operation is already processing';
  END IF;

  -- Compatibility with successful transactions committed by the pre-v2 RPC.
  -- Those rows do not have a request payload to compare, so they can only be
  -- returned by their existing tenant-scoped mutation identity.
  SELECT id INTO _legacy_sale_id
  FROM public.sales
  WHERE tenant_id = _tenant_id
    AND client_mutation_id = _client_mutation_id;

  IF _legacy_sale_id IS NOT NULL THEN
    RETURN _legacy_sale_id;
  END IF;

  -- Race-safe claim. A concurrent insert for the same tenant/mutation key waits
  -- on the unique index. Once the winner commits, the loser re-reads and either
  -- returns the same sale or rejects a payload mismatch.
  INSERT INTO public.checkout_operations (
    tenant_id,
    branch_id,
    user_id,
    client_mutation_id,
    request_payload,
    status
  ) VALUES (
    _tenant_id,
    _branch_id,
    _user_id,
    _client_mutation_id,
    _request_payload,
    'processing'
  )
  ON CONFLICT (tenant_id, client_mutation_id) DO NOTHING
  RETURNING id INTO _operation_id;

  IF _operation_id IS NULL THEN
    SELECT * INTO _operation
    FROM public.checkout_operations
    WHERE tenant_id = _tenant_id
      AND client_mutation_id = _client_mutation_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Could not acquire checkout idempotency record';
    END IF;
    IF _operation.request_payload IS DISTINCT FROM _request_payload THEN
      RAISE EXCEPTION 'Client mutation ID was already used for a different checkout request';
    END IF;
    IF _operation.status = 'completed' AND _operation.sale_id IS NOT NULL THEN
      RETURN _operation.sale_id;
    END IF;
    RAISE EXCEPTION 'Checkout operation is already processing';
  END IF;

  SELECT COALESCE(dev_mode, false)
  INTO _dev_mode
  FROM public.tenants
  WHERE id = _tenant_id;

  IF _channel IN ('pos','tables') THEN
    IF _cash_session_id IS NULL AND NOT _dev_mode THEN
      RAISE EXCEPTION 'Checkout must identify the exact open cash session';
    END IF;

    IF _cash_session_id IS NOT NULL THEN
      SELECT id INTO _session_id
      FROM public.cash_sessions
      WHERE id = _cash_session_id
        AND tenant_id = _tenant_id
        AND branch_id = _branch_id
        AND status = 'open'
      FOR UPDATE;

      IF _session_id IS NULL THEN
        RAISE EXCEPTION 'The selected cash session is not open for this branch';
      END IF;
    END IF;
  ELSIF _cash_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'A cash session may only be attached to in-person checkout';
  END IF;

  IF _customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.customers
    WHERE id = _customer_id
      AND tenant_id = _tenant_id
  ) THEN
    RAISE EXCEPTION 'Customer does not belong to this business';
  END IF;

  INSERT INTO public.sales (
    tenant_id,
    branch_id,
    session_id,
    user_id,
    customer_id,
    subtotal,
    tax_total,
    discount_total,
    total,
    notes,
    channel,
    tip_amount,
    coupon_code,
    client_mutation_id
  ) VALUES (
    _tenant_id,
    _branch_id,
    _session_id,
    _user_id,
    _customer_id,
    0,
    0,
    0,
    0,
    _notes,
    _channel,
    public.fils_to_bhd_numeric(_tip_amount_fils),
    NULLIF(upper(trim(COALESCE(_coupon_code, ''))), ''),
    _client_mutation_id
  )
  RETURNING id INTO _sale_id;

  FOR _item IN SELECT * FROM jsonb_array_elements(_items) LOOP
    IF NULLIF(_item->>'product_id', '') IS NULL THEN
      RAISE EXCEPTION 'Every sale item requires a product ID';
    END IF;

    BEGIN
      _quantity := (_item->>'quantity')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Item quantity must be a valid number';
    END;

    IF _quantity IS NULL OR _quantity <= 0 THEN
      RAISE EXCEPTION 'Item quantity must be greater than zero';
    END IF;
    IF _quantity <> round(_quantity, 3) THEN
      RAISE EXCEPTION 'Item quantity supports at most three decimal places';
    END IF;

    SELECT
      p.id,
      p.name,
      p.product_type,
      COALESCE(p.tax_rate, 0) AS tax_rate,
      COALESCE(
        (
          SELECT pcp.price_fils
          FROM public.product_channel_prices pcp
          WHERE pcp.tenant_id = _tenant_id
            AND pcp.product_id = p.id
            AND pcp.branch_id = _branch_id
            AND pcp.channel = _channel
          LIMIT 1
        ),
        (
          SELECT pcp.price_fils
          FROM public.product_channel_prices pcp
          WHERE pcp.tenant_id = _tenant_id
            AND pcp.product_id = p.id
            AND pcp.branch_id IS NULL
            AND pcp.channel = _channel
          LIMIT 1
        ),
        bp.local_price_fils,
        p.price_fils
      ) AS resolved_price_fils
    INTO _product
    FROM public.products p
    LEFT JOIN public.branch_products bp
      ON bp.tenant_id = _tenant_id
      AND bp.product_id = p.id
      AND bp.branch_id = _branch_id
    WHERE p.id = (_item->>'product_id')::uuid
      AND p.tenant_id = _tenant_id
      AND p.status = 'active'
      AND COALESCE(bp.is_available, true) = true;

    IF NOT FOUND OR _product.resolved_price_fils IS NULL THEN
      RAISE EXCEPTION 'Product % is unavailable for this branch', _item->>'product_id';
    END IF;

    _modifier_requested := jsonb_array_length(COALESCE(_item->'modifiers', '[]'::jsonb));
    _modifier_delta_fils := 0;
    _modifier_valid := 0;

    IF _modifier_requested > 0 THEN
      SELECT
        COALESCE(sum(public.bhd_numeric_to_fils(mo.price_delta)), 0),
        count(*)
      INTO _modifier_delta_fils, _modifier_valid
      FROM jsonb_array_elements(COALESCE(_item->'modifiers', '[]'::jsonb)) selected
      JOIN public.modifier_options mo
        ON mo.id = (selected->>'option_id')::uuid
       AND mo.is_available = true
      JOIN public.modifier_groups mg
        ON mg.id = mo.group_id
      WHERE mg.tenant_id = _tenant_id
        AND mg.product_id = _product.id;

      IF _modifier_valid <> _modifier_requested THEN
        RAISE EXCEPTION 'One or more product modifiers are invalid or unavailable';
      END IF;
    END IF;

    _unit_price_fils := _product.resolved_price_fils + _modifier_delta_fils;
    IF _unit_price_fils < 0 THEN
      RAISE EXCEPTION 'Resolved product price cannot be negative';
    END IF;
    _authoritative_unit_price_fils := _unit_price_fils;
    _override := NULL;

    IF NULLIF(_item->>'price_override_request_id', '') IS NOT NULL THEN
      SELECT * INTO _override
      FROM public.price_override_requests
      WHERE id = (_item->>'price_override_request_id')::uuid
      FOR UPDATE;

      IF NOT FOUND
         OR _override.tenant_id IS DISTINCT FROM _tenant_id
         OR _override.branch_id IS DISTINCT FROM _branch_id
         OR _override.product_id IS DISTINCT FROM _product.id
         OR _override.requested_by IS DISTINCT FROM _user_id THEN
        RAISE EXCEPTION 'Price override is not authorized for this checkout line';
      END IF;
      IF _override.status <> 'approved' THEN
        RAISE EXCEPTION 'Price override is not approved or was already consumed';
      END IF;
      IF _override.expires_at <= now() THEN
        RAISE EXCEPTION 'Price override approval has expired';
      END IF;
      IF _override.channel IS DISTINCT FROM _channel
         OR _override.quantity < _quantity
         OR _override.modifiers_snapshot IS DISTINCT FROM COALESCE(_item->'modifiers', '[]'::jsonb)
         OR _override.original_unit_price_fils IS DISTINCT FROM _authoritative_unit_price_fils THEN
        RAISE EXCEPTION 'Price override approval is stale or does not match this checkout line';
      END IF;
      _unit_price_fils := _override.requested_unit_price_fils;
    END IF;

    BEGIN
      _line_discount_fils := COALESCE((_item->>'discount_fils')::bigint, 0);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Line discount must be an integer number of fils';
    END;

    IF _line_discount_fils < 0 THEN
      RAISE EXCEPTION 'Line discount cannot be negative';
    END IF;

    IF _line_discount_fils > 0 AND NOT public.has_branch_role(
      _user_id,
      _tenant_id,
      _branch_id,
      ARRAY['owner','admin','manager']::public.app_role[]
    ) THEN
      RAISE EXCEPTION 'Manager authorization is required for line discounts';
    END IF;

    _line_subtotal_fils := round(_unit_price_fils::numeric * _quantity)::bigint - _line_discount_fils;
    IF _line_subtotal_fils < 0 THEN
      RAISE EXCEPTION 'Line discount cannot exceed the line subtotal';
    END IF;

    _line_tax_fils := round(
      _line_subtotal_fils::numeric * _product.tax_rate / 100
    )::bigint;
    _line_total_fils := _line_subtotal_fils + _line_tax_fils;

    INSERT INTO public.sale_items (
      tenant_id,
      sale_id,
      product_id,
      product_name,
      product_type,
      quantity,
      unit_price,
      tax_rate,
      discount,
      line_total,
      modifiers,
      original_unit_price_fils,
      price_override_request_id,
      price_override_reason,
      price_override_approved_by,
      price_override_approved_at
    ) VALUES (
      _tenant_id,
      _sale_id,
      _product.id,
      _product.name,
      _product.product_type,
      _quantity,
      public.fils_to_bhd_numeric(_unit_price_fils),
      _product.tax_rate,
      public.fils_to_bhd_numeric(_line_discount_fils),
      public.fils_to_bhd_numeric(_line_total_fils),
      COALESCE(_item->'modifiers', '[]'::jsonb),
      CASE WHEN _override.id IS NOT NULL THEN _authoritative_unit_price_fils ELSE NULL END,
      _override.id,
      CASE WHEN _override.id IS NOT NULL THEN _override.request_reason ELSE NULL END,
      _override.approved_by,
      _override.approved_at
    )
    RETURNING id INTO _sale_item_id;

    IF _override.id IS NOT NULL THEN
      UPDATE public.price_override_requests
      SET status = 'consumed', consumed_at = now(), consumed_sale_id = _sale_id,
          consumed_sale_item_id = _sale_item_id, updated_at = now()
      WHERE id = _override.id AND status = 'approved';
      IF NOT FOUND THEN RAISE EXCEPTION 'Price override approval was already consumed'; END IF;

      INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
      VALUES (_tenant_id,_user_id,'pos.price_override_consumed','price_override_requests',_override.id,
        jsonb_build_object('branch_id',_branch_id,'sale_id',_sale_id,'sale_item_id',_sale_item_id,
          'product_id',_product.id,'original_unit_price_fils',_authoritative_unit_price_fils,
          'override_unit_price_fils',_unit_price_fils,'approved_by',_override.approved_by,
          'request_reason',_override.request_reason,'client_mutation_id',_client_mutation_id));
    END IF;

    _subtotal_fils := _subtotal_fils + _line_subtotal_fils;
    _tax_total_fils := _tax_total_fils + _line_tax_fils;

    IF _product.product_type IN ('simple','production','combo') THEN
      PERFORM public.apply_inventory_movement(
        _tenant_id,
        _branch_id,
        _product.id,
        'sale'::public.movement_type,
        _quantity,
        _channel::text || ' sale',
        'sale',
        _sale_id,
        _user_id,
        NULL
      );
    ELSIF _product.product_type = 'composite' THEN
      FOR _component IN
        SELECT component_product_id, quantity, COALESCE(waste_pct, 0) AS waste_pct
        FROM public.product_components
        WHERE tenant_id = _tenant_id
          AND parent_product_id = _product.id
      LOOP
        PERFORM public.apply_inventory_movement(
          _tenant_id,
          _branch_id,
          _component.component_product_id,
          'consumption'::public.movement_type,
          _component.quantity * _quantity * (1 + _component.waste_pct / 100.0),
          'Composite ' || _channel::text,
          'sale',
          _sale_id,
          _user_id,
          NULL
        );
      END LOOP;
    END IF;
  END LOOP;

  IF NULLIF(trim(COALESCE(_coupon_code, '')), '') IS NOT NULL THEN
    SELECT * INTO _coupon
    FROM public.discount_codes
    WHERE tenant_id = _tenant_id
      AND upper(code) = upper(trim(_coupon_code))
      AND is_active = true
      AND starts_at <= now()
      AND (expires_at IS NULL OR expires_at >= now())
      AND (max_uses IS NULL OR current_uses < max_uses)
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Coupon is invalid, expired, or exhausted';
    END IF;

    IF _coupon.discount_type = 'percentage' THEN
      _coupon_discount_fils := round(
        (_subtotal_fils + _tax_total_fils)::numeric * _coupon.discount_value / 100
      )::bigint;
    ELSIF _coupon.discount_type = 'fixed' THEN
      _coupon_discount_fils := public.bhd_numeric_to_fils(_coupon.discount_value);
    ELSE
      RAISE EXCEPTION 'Coupon discount type is unsupported';
    END IF;

    _coupon_discount_fils := LEAST(
      GREATEST(COALESCE(_coupon_discount_fils, 0), 0),
      _subtotal_fils + _tax_total_fils
    );

    UPDATE public.discount_codes
    SET current_uses = current_uses + 1
    WHERE id = _coupon.id;
  ELSE
    _coupon_discount_fils := _discount_total_fils;

    IF _coupon_discount_fils > 0 AND NOT public.has_branch_role(
      _user_id,
      _tenant_id,
      _branch_id,
      ARRAY['owner','admin','manager']::public.app_role[]
    ) THEN
      RAISE EXCEPTION 'Manager authorization is required for order discounts';
    END IF;

    _coupon_discount_fils := LEAST(
      _coupon_discount_fils,
      _subtotal_fils + _tax_total_fils
    );
  END IF;

  _total_fils := _subtotal_fils
    + _tax_total_fils
    - _coupon_discount_fils
    + _tip_amount_fils;

  IF _total_fils < 0 THEN
    RAISE EXCEPTION 'Sale total cannot be negative';
  END IF;

  FOR _pay IN SELECT * FROM jsonb_array_elements(_payments) LOOP
    IF COALESCE(_pay->>'method', '') NOT IN ('cash','card','transfer','qr') THEN
      RAISE EXCEPTION 'Unsupported payment method: %', COALESCE(_pay->>'method', '');
    END IF;

    BEGIN
      _payment_fils := (_pay->>'amount_fils')::bigint;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Every payment allocation must use an integer amount_fils';
    END;

    IF _payment_fils IS NULL OR _payment_fils <= 0 THEN
      RAISE EXCEPTION 'Every payment allocation must be greater than zero';
    END IF;

    IF _payment_total_fils > 9223372036854775807 - _payment_fils THEN
      RAISE EXCEPTION 'Payment total exceeds the supported range';
    END IF;

    _payment_total_fils := _payment_total_fils + _payment_fils;
  END LOOP;

  IF (_channel IN ('pos','tables') OR jsonb_array_length(_payments) > 0)
     AND _payment_total_fils <> _total_fils THEN
    RAISE EXCEPTION 'Payments (% fils) must exactly equal sale total (% fils)',
      _payment_total_fils,
      _total_fils;
  END IF;

  UPDATE public.sales
  SET subtotal = public.fils_to_bhd_numeric(_subtotal_fils),
      tax_total = public.fils_to_bhd_numeric(_tax_total_fils),
      discount_total = public.fils_to_bhd_numeric(_coupon_discount_fils),
      total = public.fils_to_bhd_numeric(_total_fils),
      tip_amount = public.fils_to_bhd_numeric(_tip_amount_fils)
  WHERE id = _sale_id;

  FOR _pay IN SELECT * FROM jsonb_array_elements(_payments) LOOP
    _payment_fils := (_pay->>'amount_fils')::bigint;

    INSERT INTO public.payments (
      tenant_id,
      sale_id,
      method,
      amount,
      reference
    ) VALUES (
      _tenant_id,
      _sale_id,
      (_pay->>'method')::public.payment_method,
      public.fils_to_bhd_numeric(_payment_fils),
      NULLIF(trim(COALESCE(_pay->>'reference', '')), '')
    );

    IF _session_id IS NOT NULL THEN
      UPDATE public.cash_sessions
      SET total_cash = total_cash + CASE
            WHEN _pay->>'method' = 'cash' THEN public.fils_to_bhd_numeric(_payment_fils)
            ELSE 0
          END,
          total_card = total_card + CASE
            WHEN _pay->>'method' = 'card' THEN public.fils_to_bhd_numeric(_payment_fils)
            ELSE 0
          END,
          total_transfer = total_transfer + CASE
            WHEN _pay->>'method' = 'transfer' THEN public.fils_to_bhd_numeric(_payment_fils)
            ELSE 0
          END,
          total_qr = total_qr + CASE
            WHEN _pay->>'method' = 'qr' THEN public.fils_to_bhd_numeric(_payment_fils)
            ELSE 0
          END
      WHERE id = _session_id;
    END IF;
  END LOOP;

  -- Preserve the existing loyalty policy until the dedicated loyalty-ledger phase.
  IF _customer_id IS NOT NULL THEN
    SELECT points_per_thousand
    INTO _points_config
    FROM public.tenants
    WHERE id = _tenant_id;

    _points_earned := floor(_total_fils::numeric / 1000) * COALESCE(_points_config, 0);
    IF _points_earned > 0 THEN
      UPDATE public.customers
      SET loyalty_points = loyalty_points + _points_earned
      WHERE id = _customer_id
        AND tenant_id = _tenant_id;
    END IF;
  END IF;

  INSERT INTO public.operation_log (
    tenant_id,
    branch_id,
    operation_type,
    client_mutation_id,
    entity_type,
    entity_id,
    payload
  ) VALUES (
    _tenant_id,
    _branch_id,
    'checkout_sale_v2',
    _client_mutation_id,
    'sales',
    _sale_id,
    jsonb_build_object(
      'channel', _channel,
      'total_fils', _total_fils,
      'payment_total_fils', _payment_total_fils,
      'cash_session_id', _session_id
    )
  )
  ON CONFLICT (tenant_id, client_mutation_id) DO UPDATE
  SET entity_type = EXCLUDED.entity_type,
      entity_id = EXCLUDED.entity_id,
      payload = EXCLUDED.payload,
      status = 'success';

  UPDATE public.checkout_operations
  SET status = 'completed',
      sale_id = _sale_id,
      completed_at = now()
  WHERE id = _operation_id;

  INSERT INTO public.audit_logs (
    tenant_id,
    user_id,
    action,
    entity,
    entity_id,
    metadata
  ) VALUES (
    _tenant_id,
    _user_id,
    'sale.checkout_committed',
    'sales',
    _sale_id,
    jsonb_build_object(
      'branch_id', _branch_id,
      'channel', _channel,
      'subtotal_fils', _subtotal_fils,
      'tax_total_fils', _tax_total_fils,
      'discount_total_fils', _coupon_discount_fils,
      'tip_amount_fils', _tip_amount_fils,
      'total_fils', _total_fils,
      'payment_allocations', jsonb_array_length(_payments),
      'client_mutation_id', _client_mutation_id,
      'cash_session_id', _session_id
    )
  );

  RETURN _sale_id;
END;
$$;

REVOKE ALL ON FUNCTION public.checkout_sale_v2(
  uuid,
  uuid,
  jsonb,
  jsonb,
  bigint,
  text,
  uuid,
  public.sales_channel,
  bigint,
  text,
  text,
  uuid
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.checkout_sale_v2(
  uuid,
  uuid,
  jsonb,
  jsonb,
  bigint,
  text,
  uuid,
  public.sales_channel,
  bigint,
  text,
  text,
  uuid
) TO authenticated;

COMMENT ON FUNCTION public.checkout_sale_v2(
  uuid,
  uuid,
  jsonb,
  jsonb,
  bigint,
  text,
  uuid,
  public.sales_channel,
  bigint,
  text,
  text,
  uuid
) IS
  'Server-authoritative checkout with exact fils, payment reconciliation, tenant/branch authorization, race-safe idempotency, and one-time manager-approved price override consumption.';


COMMIT;
