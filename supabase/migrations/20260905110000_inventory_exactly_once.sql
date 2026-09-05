-- ZAIPOS P0 transaction core: exactly-once inventory command layer.
--
-- Client-facing stock mutations receive a stable operation ID and canonical
-- request payload. The low-level movement primitive remains available to
-- SECURITY DEFINER server commands, but authenticated clients may no longer
-- invoke it directly. Multi-effect commands are idempotent as a transaction,
-- avoiding unsafe uniqueness assumptions on individual movement rows.

BEGIN;

CREATE TABLE IF NOT EXISTS public.inventory_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  operation_type text NOT NULL,
  client_mutation_id text NOT NULL,
  request_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT inventory_operations_mutation_id CHECK (length(trim(client_mutation_id)) >= 8),
  CONSTRAINT inventory_operations_status CHECK (status IN ('processing','completed')),
  UNIQUE(tenant_id, client_mutation_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_operations_branch_created
  ON public.inventory_operations(branch_id, created_at DESC);

ALTER TABLE public.inventory_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_operations_branch_select_v2 ON public.inventory_operations;
CREATE POLICY inventory_operations_branch_select_v2
ON public.inventory_operations
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager','inventory','kitchen']::public.app_role[]
  )
);

REVOKE ALL ON public.inventory_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inventory_operations TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_inventory_operation_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _operation_type text,
  _client_mutation_id text,
  _request_payload jsonb
)
RETURNS TABLE(operation_id uuid, is_replay boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_id uuid;
  _existing public.inventory_operations;
BEGIN
  _client_mutation_id := NULLIF(trim(COALESCE(_client_mutation_id, '')), '');
  IF _client_mutation_id IS NULL OR length(_client_mutation_id) < 8 THEN
    RAISE EXCEPTION 'A stable client mutation ID is required for inventory operations';
  END IF;

  INSERT INTO public.inventory_operations (
    tenant_id, branch_id, operation_type, client_mutation_id, request_payload
  ) VALUES (
    _tenant_id, _branch_id, _operation_type, _client_mutation_id, _request_payload
  )
  ON CONFLICT (tenant_id, client_mutation_id) DO NOTHING
  RETURNING id INTO _new_id;

  IF _new_id IS NOT NULL THEN
    operation_id := _new_id;
    is_replay := false;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO _existing
  FROM public.inventory_operations
  WHERE tenant_id = _tenant_id
    AND client_mutation_id = _client_mutation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not acquire inventory idempotency record';
  END IF;

  IF _existing.branch_id IS DISTINCT FROM _branch_id
     OR _existing.operation_type IS DISTINCT FROM _operation_type
     OR _existing.request_payload IS DISTINCT FROM _request_payload
  THEN
    RAISE EXCEPTION 'Client mutation ID was already used for a different inventory request';
  END IF;

  IF _existing.status = 'completed' THEN
    operation_id := _existing.id;
    is_replay := true;
    RETURN NEXT;
    RETURN;
  END IF;

  RAISE EXCEPTION 'Inventory operation is already processing';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_inventory_operation_v2(uuid,uuid,text,text,jsonb)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_inventory_batch_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _inventory_center_id uuid,
  _movements jsonb,
  _client_mutation_id text,
  _reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _request jsonb;
  _claim record;
  _operation_id uuid;
  _item jsonb;
  _quantity numeric;
  _movement_type public.movement_type;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(
    _user_id, _tenant_id, _branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = _branch_id AND tenant_id = _tenant_id AND status = 'active'
  ) THEN RAISE EXCEPTION 'Inventory branch is invalid or inactive'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_centers
    WHERE id = _inventory_center_id
      AND tenant_id = _tenant_id
      AND branch_id = _branch_id
      AND status = 'active'
  ) THEN RAISE EXCEPTION 'Inventory center is invalid or inactive'; END IF;

  IF _movements IS NULL OR jsonb_typeof(_movements) <> 'array' OR jsonb_array_length(_movements) = 0 THEN
    RAISE EXCEPTION 'Inventory batch must contain at least one movement';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(_movements) x
    WHERE NULLIF(trim(COALESCE(x->>'effect_key','')), '') IS NULL
  ) THEN RAISE EXCEPTION 'Every inventory batch movement requires an effect key'; END IF;

  IF (SELECT count(*) FROM jsonb_array_elements(_movements)) <>
     (SELECT count(DISTINCT x->>'effect_key') FROM jsonb_array_elements(_movements) x)
  THEN RAISE EXCEPTION 'Inventory batch effect keys must be unique'; END IF;

  _request := jsonb_build_object(
    'tenant_id', _tenant_id,
    'branch_id', _branch_id,
    'inventory_center_id', _inventory_center_id,
    'movements', _movements,
    'reason', NULLIF(trim(COALESCE(_reason,'')), '')
  );

  SELECT * INTO _claim
  FROM public.claim_inventory_operation_v2(
    _tenant_id, _branch_id, 'inventory_batch', _client_mutation_id, _request
  );
  _operation_id := _claim.operation_id;
  IF _claim.is_replay THEN RETURN _operation_id; END IF;

  FOR _item IN SELECT value FROM jsonb_array_elements(_movements) LOOP
    IF NULLIF(_item->>'product_id','') IS NULL THEN
      RAISE EXCEPTION 'Every inventory movement requires a product ID';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.products
      WHERE id = (_item->>'product_id')::uuid
        AND tenant_id = _tenant_id
        AND status = 'active'
    ) THEN RAISE EXCEPTION 'Inventory product is invalid or inactive'; END IF;

    IF COALESCE(_item->>'movement_type','') NOT IN ('purchase','adjustment','waste','return') THEN
      RAISE EXCEPTION 'Unsupported direct inventory movement type: %', COALESCE(_item->>'movement_type','');
    END IF;
    _movement_type := (_item->>'movement_type')::public.movement_type;

    BEGIN
      _quantity := (_item->>'quantity')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Inventory quantity must be a valid number';
    END;
    IF _quantity IS NULL OR _quantity <= 0 OR _quantity <> round(_quantity, 3) THEN
      RAISE EXCEPTION 'Inventory quantity must be positive with at most three decimal places';
    END IF;

    PERFORM public.apply_inventory_movement(
      _tenant_id, _branch_id, (_item->>'product_id')::uuid,
      _movement_type, _quantity,
      COALESCE(NULLIF(trim(COALESCE(_reason,'')), ''), 'Inventory batch'),
      'inventory_operation', _operation_id, _user_id, _inventory_center_id
    );
  END LOOP;

  UPDATE public.inventory_operations
  SET status = 'completed', completed_at = now()
  WHERE id = _operation_id;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.audit_logs (tenant_id,user_id,action,entity,entity_id,metadata) VALUES ($1,$2,$3,$4,$5,$6)'
    USING _tenant_id, _user_id, 'inventory.batch_v2', 'inventory_operations', _operation_id,
      jsonb_build_object('branch_id',_branch_id,'inventory_center_id',_inventory_center_id,'movement_count',jsonb_array_length(_movements),'client_mutation_id',_client_mutation_id);
  END IF;

  RETURN _operation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_inventory_batch_v2(uuid,uuid,uuid,jsonb,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_inventory_batch_v2(uuid,uuid,uuid,jsonb,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.transfer_inventory_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _product_id uuid,
  _from_center_id uuid,
  _to_center_id uuid,
  _quantity numeric,
  _reason text,
  _client_mutation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _request jsonb;
  _claim record;
  _operation_id uuid;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(
    _user_id,_tenant_id,_branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF _from_center_id = _to_center_id THEN
    RAISE EXCEPTION 'Source and destination inventory centers must differ';
  END IF;
  IF _quantity IS NULL OR _quantity <= 0 OR _quantity <> round(_quantity,3) THEN
    RAISE EXCEPTION 'Transfer quantity must be positive with at most three decimal places';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id=_product_id AND tenant_id=_tenant_id AND status='active'
  ) THEN RAISE EXCEPTION 'Transfer product is invalid or inactive'; END IF;
  IF 2 <> (
    SELECT count(*) FROM public.inventory_centers
    WHERE id IN (_from_center_id,_to_center_id)
      AND tenant_id=_tenant_id AND branch_id=_branch_id AND status='active'
  ) THEN RAISE EXCEPTION 'Transfer inventory center is invalid or inactive'; END IF;

  _request := jsonb_build_object(
    'tenant_id',_tenant_id,'branch_id',_branch_id,'product_id',_product_id,
    'from_center_id',_from_center_id,'to_center_id',_to_center_id,
    'quantity',_quantity,'reason',NULLIF(trim(COALESCE(_reason,'')),'')
  );
  SELECT * INTO _claim
  FROM public.claim_inventory_operation_v2(
    _tenant_id,_branch_id,'inventory_transfer',_client_mutation_id,_request
  );
  _operation_id := _claim.operation_id;
  IF _claim.is_replay THEN RETURN _operation_id; END IF;

  PERFORM public.apply_inventory_movement(
    _tenant_id,_branch_id,_product_id,'transfer'::public.movement_type,_quantity,
    COALESCE(NULLIF(trim(COALESCE(_reason,'')),''),'Inventory transfer'),
    'inventory_operation',_operation_id,_user_id,_from_center_id
  );
  PERFORM public.apply_inventory_movement(
    _tenant_id,_branch_id,_product_id,'adjustment'::public.movement_type,_quantity,
    COALESCE(NULLIF(trim(COALESCE(_reason,'')),''),'Inventory transfer'),
    'inventory_operation',_operation_id,_user_id,_to_center_id
  );

  UPDATE public.inventory_operations SET status='completed',completed_at=now() WHERE id=_operation_id;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.audit_logs (tenant_id,user_id,action,entity,entity_id,metadata) VALUES ($1,$2,$3,$4,$5,$6)'
    USING _tenant_id,_user_id,'inventory.transfer_v2','inventory_operations',_operation_id,
      jsonb_build_object('branch_id',_branch_id,'product_id',_product_id,'from_center_id',_from_center_id,'to_center_id',_to_center_id,'quantity',_quantity,'client_mutation_id',_client_mutation_id);
  END IF;
  RETURN _operation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_inventory_v2(uuid,uuid,uuid,uuid,uuid,numeric,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_inventory_v2(uuid,uuid,uuid,uuid,uuid,numeric,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.receive_purchase_order_v2(
  _order_id uuid,
  _inventory_center_id uuid,
  _client_mutation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _po record;
  _line record;
  _request jsonb;
  _claim record;
  _operation_id uuid;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT id,tenant_id,branch_id,status INTO _po
  FROM public.purchase_orders WHERE id=_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF NOT public.has_branch_role(
    _user_id,_po.tenant_id,_po.branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_centers
    WHERE id=_inventory_center_id AND tenant_id=_po.tenant_id
      AND branch_id=_po.branch_id AND status='active'
  ) THEN RAISE EXCEPTION 'Inventory center is invalid or inactive'; END IF;

  _request := jsonb_build_object(
    'order_id',_order_id,'inventory_center_id',_inventory_center_id
  );
  SELECT * INTO _claim
  FROM public.claim_inventory_operation_v2(
    _po.tenant_id,_po.branch_id,'purchase_order_receive',_client_mutation_id,_request
  );
  _operation_id := _claim.operation_id;
  IF _claim.is_replay THEN RETURN _operation_id; END IF;

  IF _po.status = 'received' THEN
    RAISE EXCEPTION 'Purchase order is already received under another operation';
  END IF;

  FOR _line IN
    SELECT product_id,quantity
    FROM public.purchase_order_items
    WHERE order_id=_order_id
    ORDER BY id
  LOOP
    IF _line.product_id IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.products
      WHERE id=_line.product_id AND tenant_id=_po.tenant_id AND status='active'
    ) THEN RAISE EXCEPTION 'Purchase-order product is invalid or inactive'; END IF;
    IF _line.quantity IS NULL OR _line.quantity <= 0 OR _line.quantity <> round(_line.quantity,3) THEN
      RAISE EXCEPTION 'Purchase-order quantity must be positive with at most three decimal places';
    END IF;
    PERFORM public.apply_inventory_movement(
      _po.tenant_id,_po.branch_id,_line.product_id,'purchase'::public.movement_type,_line.quantity,
      'Purchase order ' || _order_id::text,'inventory_operation',_operation_id,_user_id,_inventory_center_id
    );
  END LOOP;

  UPDATE public.purchase_orders
  SET status='received',received_at=now()
  WHERE id=_order_id;
  UPDATE public.inventory_operations SET status='completed',completed_at=now() WHERE id=_operation_id;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.audit_logs (tenant_id,user_id,action,entity,entity_id,metadata) VALUES ($1,$2,$3,$4,$5,$6)'
    USING _po.tenant_id,_user_id,'purchase_order.received_v2','inventory_operations',_operation_id,
      jsonb_build_object('branch_id',_po.branch_id,'purchase_order_id',_order_id,'inventory_center_id',_inventory_center_id,'client_mutation_id',_client_mutation_id);
  END IF;
  RETURN _operation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.receive_purchase_order_v2(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order_v2(uuid,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_production_order_v2(
  _order_id uuid,
  _produced numeric,
  _waste numeric,
  _client_mutation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _o record;
  _comp record;
  _center_id uuid;
  _request jsonb;
  _claim record;
  _operation_id uuid;
  _consumed numeric;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT id,tenant_id,branch_id,product_id,status INTO _o
  FROM public.production_orders WHERE id=_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production order not found'; END IF;
  IF NOT public.has_branch_role(
    _user_id,_o.tenant_id,_o.branch_id,
    ARRAY['owner','admin','manager','kitchen']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF _produced IS NULL OR _produced < 0 OR _produced <> round(_produced,3) THEN
    RAISE EXCEPTION 'Produced quantity must be non-negative with at most three decimal places';
  END IF;
  IF COALESCE(_waste,0) < 0 OR COALESCE(_waste,0) <> round(COALESCE(_waste,0),3) THEN
    RAISE EXCEPTION 'Waste quantity must be non-negative with at most three decimal places';
  END IF;

  SELECT id INTO _center_id
  FROM public.inventory_centers
  WHERE tenant_id=_o.tenant_id AND branch_id=_o.branch_id AND status='active'
  ORDER BY is_default DESC,id
  LIMIT 1;
  IF _center_id IS NULL THEN RAISE EXCEPTION 'No active inventory center exists for production branch'; END IF;

  _request := jsonb_build_object(
    'order_id',_order_id,'produced',_produced,'waste',COALESCE(_waste,0),'inventory_center_id',_center_id
  );
  SELECT * INTO _claim
  FROM public.claim_inventory_operation_v2(
    _o.tenant_id,_o.branch_id,'production_complete',_client_mutation_id,_request
  );
  _operation_id := _claim.operation_id;
  IF _claim.is_replay THEN RETURN _operation_id; END IF;

  IF _o.status = 'completed' THEN
    RAISE EXCEPTION 'Production order is already completed under another operation';
  END IF;

  FOR _comp IN
    SELECT component_product_id,quantity,COALESCE(waste_pct,0) AS waste_pct
    FROM public.product_components
    WHERE parent_product_id=_o.product_id
    ORDER BY id
  LOOP
    _consumed := _comp.quantity * _produced * (1 + _comp.waste_pct / 100.0);
    IF _consumed > 0 THEN
      PERFORM public.apply_inventory_movement(
        _o.tenant_id,_o.branch_id,_comp.component_product_id,'consumption'::public.movement_type,_consumed,
        'Production order','inventory_operation',_operation_id,_user_id,_center_id
      );
      INSERT INTO public.production_consumptions(tenant_id,order_id,product_id,quantity)
      VALUES (_o.tenant_id,_order_id,_comp.component_product_id,_consumed);
    END IF;
  END LOOP;

  IF _produced > 0 THEN
    PERFORM public.apply_inventory_movement(
      _o.tenant_id,_o.branch_id,_o.product_id,'production'::public.movement_type,_produced,
      'Production output','inventory_operation',_operation_id,_user_id,_center_id
    );
  END IF;

  UPDATE public.production_orders
  SET status='completed',produced_quantity=_produced,waste_quantity=COALESCE(_waste,0),completed_at=now(),user_id=_user_id
  WHERE id=_order_id;
  UPDATE public.inventory_operations SET status='completed',completed_at=now() WHERE id=_operation_id;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.audit_logs (tenant_id,user_id,action,entity,entity_id,metadata) VALUES ($1,$2,$3,$4,$5,$6)'
    USING _o.tenant_id,_user_id,'production.completed_v2','inventory_operations',_operation_id,
      jsonb_build_object('branch_id',_o.branch_id,'production_order_id',_order_id,'produced',_produced,'waste',COALESCE(_waste,0),'client_mutation_id',_client_mutation_id);
  END IF;
  RETURN _operation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_production_order_v2(uuid,numeric,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_production_order_v2(uuid,numeric,numeric,text) TO authenticated;

-- Table dispatch already carries an immutable item identity. Serialize the item
-- state transition so concurrent callers cannot both observe the pre-effect
-- state and apply stock twice.
CREATE OR REPLACE FUNCTION public.dispatch_table_item(_item_id uuid)
RETURNS public.table_order_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _it public.table_order_items;
  _o public.table_orders;
  _comp record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO _it FROM public.table_order_items WHERE id=_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found'; END IF;
  IF NOT public.is_tenant_member(auth.uid(),_it.tenant_id) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF _it.status='dispatched' THEN RETURN _it; END IF;
  IF _it.status='cancelled' THEN RAISE EXCEPTION 'Item cancelled'; END IF;
  SELECT * INTO _o FROM public.table_orders WHERE id=_it.order_id;

  IF _it.product_type IN ('simple','production','combo') THEN
    PERFORM public.apply_inventory_movement(
      _o.tenant_id,_o.branch_id,_it.product_id,'sale'::public.movement_type,_it.quantity,
      'Table dispatch','table_order',_o.id,auth.uid(),NULL
    );
  ELSIF _it.product_type='composite' THEN
    FOR _comp IN
      SELECT component_product_id,quantity,COALESCE(waste_pct,0) AS waste_pct
      FROM public.product_components WHERE parent_product_id=_it.product_id
    LOOP
      PERFORM public.apply_inventory_movement(
        _o.tenant_id,_o.branch_id,_comp.component_product_id,'consumption'::public.movement_type,
        _comp.quantity*_it.quantity*(1+_comp.waste_pct/100.0),
        'Table dispatch composite','table_order',_o.id,auth.uid(),NULL
      );
    END LOOP;
  END IF;

  UPDATE public.table_order_items
  SET status='dispatched',dispatched_at=now(),dispatched_by=auth.uid()
  WHERE id=_item_id RETURNING * INTO _it;
  RETURN _it;
END;
$$;

CREATE OR REPLACE FUNCTION public.undispatch_table_item(_item_id uuid)
RETURNS public.table_order_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _it public.table_order_items;
  _o public.table_orders;
  _comp record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO _it FROM public.table_order_items WHERE id=_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found'; END IF;
  IF NOT public.is_tenant_member(auth.uid(),_it.tenant_id) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF _it.status <> 'dispatched' THEN RETURN _it; END IF;
  SELECT * INTO _o FROM public.table_orders WHERE id=_it.order_id;

  IF _it.product_type IN ('simple','production','combo') THEN
    PERFORM public.apply_inventory_movement(
      _o.tenant_id,_o.branch_id,_it.product_id,'return'::public.movement_type,_it.quantity,
      'Table undispatch','table_order',_o.id,auth.uid(),NULL
    );
  ELSIF _it.product_type='composite' THEN
    FOR _comp IN
      SELECT component_product_id,quantity,COALESCE(waste_pct,0) AS waste_pct
      FROM public.product_components WHERE parent_product_id=_it.product_id
    LOOP
      PERFORM public.apply_inventory_movement(
        _o.tenant_id,_o.branch_id,_comp.component_product_id,'return'::public.movement_type,
        _comp.quantity*_it.quantity*(1+_comp.waste_pct/100.0),
        'Table undispatch composite','table_order',_o.id,auth.uid(),NULL
      );
    END LOOP;
  END IF;

  UPDATE public.table_order_items
  SET status='pending',dispatched_at=NULL,dispatched_by=NULL
  WHERE id=_item_id RETURNING * INTO _it;
  RETURN _it;
END;
$$;

-- Low-level stock mutation is server-command-owned from this point onward.
REVOKE EXECUTE ON FUNCTION public.apply_inventory_movement(
  uuid,uuid,uuid,public.movement_type,numeric,text,text,uuid,uuid,uuid
) FROM PUBLIC, anon, authenticated;

-- Disable weaker public commands once their v2 replacements exist. Internal
-- historical callers continue to use apply_inventory_movement through their own
-- SECURITY DEFINER transaction boundaries.
DO $$
BEGIN
  IF to_regprocedure('public.transfer_inventory(uuid,uuid,uuid,uuid,uuid,numeric,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.transfer_inventory(uuid,uuid,uuid,uuid,uuid,numeric,text) FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.complete_production_order(uuid,numeric,numeric)') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.complete_production_order(uuid,numeric,numeric) FROM PUBLIC, anon, authenticated';
  END IF;
END;
$$;

COMMENT ON TABLE public.inventory_operations IS
  'P0 exactly-once command ledger for client-facing stock mutations. One stable mutation ID owns all inventory effects of a business operation.';

COMMIT;
