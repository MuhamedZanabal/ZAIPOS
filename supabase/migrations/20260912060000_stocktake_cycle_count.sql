-- ZAIPOS P1 inventory: authoritative stocktake / cycle-count lifecycle.
--
-- Physical counts are evidence, not stock authority. A stocktake snapshots server
-- stock, records operator counts through payload-bound commands, rejects stale
-- sessions if inventory changes while counting, and delegates final stock effects
-- to the existing exactly-once reconcile_inventory_levels_v2 boundary.
-- Lot-controlled products fail closed because aggregate-only counts cannot invent
-- batch/expiry provenance.

BEGIN;

CREATE TABLE public.stocktakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  inventory_center_id uuid NOT NULL REFERENCES public.inventory_centers(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open',
  reason text,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  finalized_at timestamptz,
  finalize_client_mutation_id text,
  inventory_operation_id uuid REFERENCES public.inventory_operations(id) ON DELETE RESTRICT,
  cancelled_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  cancel_reason text,
  CONSTRAINT stocktakes_status_check CHECK (status IN ('open','finalized','cancelled')),
  CONSTRAINT stocktakes_finalized_evidence CHECK (
    (status <> 'finalized') OR
    (finalized_by IS NOT NULL AND finalized_at IS NOT NULL AND finalize_client_mutation_id IS NOT NULL AND inventory_operation_id IS NOT NULL)
  ),
  CONSTRAINT stocktakes_cancelled_evidence CHECK (
    (status <> 'cancelled') OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)
  )
);

CREATE TABLE public.stocktake_items (
  stocktake_id uuid NOT NULL REFERENCES public.stocktakes(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL,
  expected_quantity numeric(12,3) NOT NULL,
  expected_stock_updated_at timestamptz,
  counted_quantity numeric(12,3),
  counted_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  counted_at timestamptz,
  PRIMARY KEY (stocktake_id, product_id),
  UNIQUE (stocktake_id, ordinal),
  CONSTRAINT stocktake_items_ordinal_positive CHECK (ordinal > 0),
  CONSTRAINT stocktake_items_expected_non_negative CHECK (expected_quantity >= 0 AND expected_quantity = round(expected_quantity,3)),
  CONSTRAINT stocktake_items_counted_non_negative CHECK (counted_quantity IS NULL OR (counted_quantity >= 0 AND counted_quantity = round(counted_quantity,3))),
  CONSTRAINT stocktake_items_count_evidence CHECK (
    (counted_quantity IS NULL AND counted_by IS NULL AND counted_at IS NULL) OR
    (counted_quantity IS NOT NULL AND counted_by IS NOT NULL AND counted_at IS NOT NULL)
  )
);

CREATE INDEX stocktakes_scope_created_idx
  ON public.stocktakes(tenant_id, branch_id, inventory_center_id, created_at DESC);
CREATE INDEX stocktake_items_product_idx
  ON public.stocktake_items(product_id, stocktake_id);

ALTER TABLE public.stocktakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stocktake_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY stocktakes_branch_select
ON public.stocktakes
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  )
);

CREATE POLICY stocktake_items_branch_select
ON public.stocktake_items
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.stocktakes s
    WHERE s.id = stocktake_items.stocktake_id
      AND public.has_branch_role(
        auth.uid(), s.tenant_id, s.branch_id,
        ARRAY['owner','admin','manager','inventory']::public.app_role[]
      )
  )
);

REVOKE ALL ON public.stocktakes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.stocktake_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stocktakes TO authenticated;
GRANT SELECT ON public.stocktake_items TO authenticated;

CREATE OR REPLACE FUNCTION public.start_stocktake_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _inventory_center_id uuid,
  _product_ids jsonb,
  _reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _stocktake_id uuid;
  _product_id uuid;
  _expected_quantity numeric;
  _expected_stock_updated_at timestamptz;
  _ordinal integer := 0;
  _requested_count integer;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(
    _user_id, _tenant_id, _branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id=_branch_id AND tenant_id=_tenant_id AND status='active'
  ) THEN
    RAISE EXCEPTION 'Stocktake branch is invalid or inactive';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_centers
    WHERE id=_inventory_center_id AND tenant_id=_tenant_id
      AND branch_id=_branch_id AND status='active'
  ) THEN
    RAISE EXCEPTION 'Stocktake inventory center is invalid or inactive';
  END IF;

  IF _product_ids IS NOT NULL AND jsonb_typeof(_product_ids) <> 'array' THEN
    RAISE EXCEPTION 'Stocktake product scope must be a JSON array';
  END IF;
  IF _product_ids IS NOT NULL AND jsonb_array_length(_product_ids)=0 THEN
    RAISE EXCEPTION 'Stocktake must contain at least one product';
  END IF;

  IF _product_ids IS NULL THEN
    SELECT count(*) INTO _requested_count
    FROM public.products
    WHERE tenant_id=_tenant_id AND status='active';
  ELSE
    BEGIN
      SELECT count(DISTINCT value::uuid) INTO _requested_count
      FROM jsonb_array_elements_text(_product_ids);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Stocktake product scope contains an invalid product ID';
    END;
    IF _requested_count <> jsonb_array_length(_product_ids) THEN
      RAISE EXCEPTION 'Stocktake product scope contains duplicate product IDs';
    END IF;
  END IF;

  IF COALESCE(_requested_count,0)=0 THEN
    RAISE EXCEPTION 'Stocktake must contain at least one active product';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_inventory_controls c
    WHERE c.tenant_id=_tenant_id
      AND c.branch_id=_branch_id
      AND c.inventory_center_id=_inventory_center_id
      AND c.lot_tracking_enabled
      AND (
        _product_ids IS NULL OR
        c.product_id IN (SELECT value::uuid FROM jsonb_array_elements_text(_product_ids))
      )
  ) THEN
    RAISE EXCEPTION 'Lot-controlled products require a lot-level stocktake';
  END IF;

  INSERT INTO public.stocktakes(
    tenant_id,branch_id,inventory_center_id,status,reason,created_by
  ) VALUES(
    _tenant_id,_branch_id,_inventory_center_id,'open',NULLIF(trim(COALESCE(_reason,'')),''),_user_id
  ) RETURNING id INTO _stocktake_id;

  FOR _product_id IN
    SELECT p.id
    FROM public.products p
    WHERE p.tenant_id=_tenant_id
      AND p.status='active'
      AND (
        _product_ids IS NULL OR
        p.id IN (SELECT value::uuid FROM jsonb_array_elements_text(_product_ids))
      )
    ORDER BY p.id
  LOOP
    _ordinal := _ordinal + 1;
    _expected_quantity := 0;
    _expected_stock_updated_at := NULL;

    SELECT s.quantity, s.updated_at
    INTO _expected_quantity, _expected_stock_updated_at
    FROM public.inventory_stocks s
    WHERE s.inventory_center_id=_inventory_center_id
      AND s.product_id=_product_id
    FOR UPDATE;

    IF NOT FOUND THEN
      _expected_quantity := 0;
      _expected_stock_updated_at := NULL;
    END IF;

    INSERT INTO public.stocktake_items(
      stocktake_id,product_id,ordinal,expected_quantity,expected_stock_updated_at
    ) VALUES(
      _stocktake_id,_product_id,_ordinal,_expected_quantity,_expected_stock_updated_at
    );
  END LOOP;

  IF _ordinal <> _requested_count THEN
    RAISE EXCEPTION 'Stocktake product scope contains an invalid or inactive product';
  END IF;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES(
      _tenant_id,_user_id,'stocktake.started','stocktakes',_stocktake_id,
      jsonb_build_object(
        'branch_id',_branch_id,
        'inventory_center_id',_inventory_center_id,
        'product_count',_ordinal,
        'reason',NULLIF(trim(COALESCE(_reason,'')),'')
      )
    );
  END IF;

  RETURN _stocktake_id;
END;
$$;

REVOKE ALL ON FUNCTION public.start_stocktake_v1(uuid,uuid,uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_stocktake_v1(uuid,uuid,uuid,jsonb,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_stocktake_count_v1(
  _stocktake_id uuid,
  _product_id uuid,
  _counted_quantity numeric,
  _client_mutation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _stocktake public.stocktakes;
  _request jsonb;
  _claim record;
  _operation_id uuid;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _counted_quantity IS NULL OR _counted_quantity < 0 OR _counted_quantity <> round(_counted_quantity,3) THEN
    RAISE EXCEPTION 'Stocktake counted quantity must be non-negative with at most three decimal places';
  END IF;

  SELECT * INTO _stocktake
  FROM public.stocktakes
  WHERE id=_stocktake_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake not found'; END IF;

  IF NOT public.has_branch_role(
    _user_id,_stocktake.tenant_id,_stocktake.branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF _stocktake.status <> 'open' THEN
    RAISE EXCEPTION 'Stocktake is not open';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.stocktake_items
    WHERE stocktake_id=_stocktake_id AND product_id=_product_id
  ) THEN
    RAISE EXCEPTION 'Product is not in this stocktake scope';
  END IF;

  _request := jsonb_build_object(
    'stocktake_id',_stocktake_id,
    'product_id',_product_id,
    'counted_quantity',_counted_quantity
  );
  SELECT * INTO _claim
  FROM public.claim_inventory_operation_v2(
    _stocktake.tenant_id,_stocktake.branch_id,'stocktake_count',_client_mutation_id,_request
  );
  _operation_id := _claim.operation_id;
  IF _claim.is_replay THEN RETURN _operation_id; END IF;

  UPDATE public.stocktake_items
  SET counted_quantity=_counted_quantity,
      counted_by=_user_id,
      counted_at=now()
  WHERE stocktake_id=_stocktake_id AND product_id=_product_id;

  UPDATE public.inventory_operations
  SET status='completed',completed_at=now()
  WHERE id=_operation_id;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES(
      _stocktake.tenant_id,_user_id,'stocktake.counted','stocktakes',_stocktake_id,
      jsonb_build_object(
        'branch_id',_stocktake.branch_id,
        'inventory_center_id',_stocktake.inventory_center_id,
        'product_id',_product_id,
        'counted_quantity',_counted_quantity,
        'client_mutation_id',_client_mutation_id,
        'inventory_operation_id',_operation_id
      )
    );
  END IF;

  RETURN _operation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_stocktake_count_v1(uuid,uuid,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_stocktake_count_v1(uuid,uuid,numeric,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.finalize_stocktake_v1(
  _stocktake_id uuid,
  _client_mutation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _stocktake public.stocktakes;
  _item record;
  _current_quantity numeric;
  _current_updated_at timestamptz;
  _targets jsonb;
  _inventory_operation_id uuid;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  _client_mutation_id := NULLIF(trim(COALESCE(_client_mutation_id,'')),'');
  IF _client_mutation_id IS NULL OR length(_client_mutation_id) < 8 THEN
    RAISE EXCEPTION 'A stable client mutation ID is required to finalize a stocktake';
  END IF;

  SELECT * INTO _stocktake
  FROM public.stocktakes
  WHERE id=_stocktake_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake not found'; END IF;

  IF NOT public.has_branch_role(
    _user_id,_stocktake.tenant_id,_stocktake.branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF _stocktake.status='finalized' THEN
    IF _stocktake.finalize_client_mutation_id=_client_mutation_id
       AND _stocktake.inventory_operation_id IS NOT NULL
    THEN
      RETURN _stocktake.inventory_operation_id;
    END IF;
    RAISE EXCEPTION 'Stocktake is already finalized under a different mutation ID';
  END IF;
  IF _stocktake.status <> 'open' THEN
    RAISE EXCEPTION 'Stocktake is not open';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.stocktake_items
    WHERE stocktake_id=_stocktake_id AND counted_quantity IS NULL
  ) THEN
    RAISE EXCEPTION 'Stocktake is incomplete; every scoped product must be counted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stocktake_items si
    JOIN public.product_inventory_controls c
      ON c.tenant_id=_stocktake.tenant_id
     AND c.branch_id=_stocktake.branch_id
     AND c.inventory_center_id=_stocktake.inventory_center_id
     AND c.product_id=si.product_id
     AND c.lot_tracking_enabled
    WHERE si.stocktake_id=_stocktake_id
  ) THEN
    RAISE EXCEPTION 'Lot-controlled products require a lot-level stocktake';
  END IF;

  FOR _item IN
    SELECT * FROM public.stocktake_items
    WHERE stocktake_id=_stocktake_id
    ORDER BY product_id
  LOOP
    _current_quantity := 0;
    _current_updated_at := NULL;

    SELECT s.quantity,s.updated_at
    INTO _current_quantity,_current_updated_at
    FROM public.inventory_stocks s
    WHERE s.inventory_center_id=_stocktake.inventory_center_id
      AND s.product_id=_item.product_id
    FOR UPDATE;

    IF NOT FOUND THEN
      _current_quantity := 0;
      _current_updated_at := NULL;
    END IF;

    IF _current_quantity IS DISTINCT FROM _item.expected_quantity
       OR _item.expected_stock_updated_at IS DISTINCT FROM _current_updated_at
    THEN
      RAISE EXCEPTION 'Inventory changed after this stocktake started for product %', _item.product_id;
    END IF;
  END LOOP;

  SELECT jsonb_agg(
    jsonb_build_object(
      'product_id',product_id,
      'target_quantity',counted_quantity,
      'effect_key','stocktake:' || _stocktake_id::text || ':' || product_id::text
    ) ORDER BY ordinal
  ) INTO _targets
  FROM public.stocktake_items
  WHERE stocktake_id=_stocktake_id;

  SELECT public.reconcile_inventory_levels_v2(
    _stocktake.tenant_id,
    _stocktake.branch_id,
    _stocktake.inventory_center_id,
    _targets,
    _client_mutation_id,
    COALESCE(_stocktake.reason,'Stocktake ' || _stocktake_id::text)
  ) INTO _inventory_operation_id;

  UPDATE public.stocktakes
  SET status='finalized',
      finalized_by=_user_id,
      finalized_at=now(),
      finalize_client_mutation_id=_client_mutation_id,
      inventory_operation_id=_inventory_operation_id
  WHERE id=_stocktake_id;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES(
      _stocktake.tenant_id,_user_id,'stocktake.finalized','stocktakes',_stocktake_id,
      jsonb_build_object(
        'branch_id',_stocktake.branch_id,
        'inventory_center_id',_stocktake.inventory_center_id,
        'counted_item_count',jsonb_array_length(_targets),
        'client_mutation_id',_client_mutation_id,
        'inventory_operation_id',_inventory_operation_id
      )
    );
  END IF;

  RETURN _inventory_operation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_stocktake_v1(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_stocktake_v1(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_stocktake_v1(
  _stocktake_id uuid,
  _reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _stocktake public.stocktakes;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO _stocktake
  FROM public.stocktakes
  WHERE id=_stocktake_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake not found'; END IF;

  IF NOT public.has_branch_role(
    _user_id,_stocktake.tenant_id,_stocktake.branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF _stocktake.status='cancelled' THEN RETURN _stocktake_id; END IF;
  IF _stocktake.status <> 'open' THEN
    RAISE EXCEPTION 'Only an open stocktake can be cancelled';
  END IF;

  UPDATE public.stocktakes
  SET status='cancelled',
      cancelled_by=_user_id,
      cancelled_at=now(),
      cancel_reason=NULLIF(trim(COALESCE(_reason,'')),'')
  WHERE id=_stocktake_id;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES(
      _stocktake.tenant_id,_user_id,'stocktake.cancelled','stocktakes',_stocktake_id,
      jsonb_build_object(
        'branch_id',_stocktake.branch_id,
        'inventory_center_id',_stocktake.inventory_center_id,
        'reason',NULLIF(trim(COALESCE(_reason,'')),'')
      )
    );
  END IF;

  RETURN _stocktake_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_stocktake_v1(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_stocktake_v1(uuid,text) TO authenticated;

COMMENT ON TABLE public.stocktakes IS
  'Auditable physical count sessions. Final stock effects are committed only through reconcile_inventory_levels_v2 after snapshot freshness validation.';
COMMENT ON TABLE public.stocktake_items IS
  'Immutable opening stock snapshots plus operator physical counts for one stocktake scope.';
COMMENT ON FUNCTION public.finalize_stocktake_v1(uuid,text) IS
  'Fails closed on incomplete, stale, or lot-controlled counts and delegates fresh physical targets to the exactly-once inventory reconciliation authority.';

COMMIT;
