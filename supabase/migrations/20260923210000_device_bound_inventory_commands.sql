-- P0: all authoritative inventory financial mutations require a native-held
-- trusted-terminal credential. Existing v2 routines remain private atomic cores.
BEGIN;

-- The historical production core selected a removed `is_default` column. Keep
-- its transactional/idempotent behavior, but choose the same deterministic
-- active center used by apply_inventory_movement on the current schema.
CREATE OR REPLACE FUNCTION public.complete_production_order_v2(
  _order_id uuid, _produced numeric, _waste numeric, _client_mutation_id text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _user_id uuid := auth.uid(); _o record; _comp record; _center_id uuid;
  _request jsonb; _claim record; _operation_id uuid; _consumed numeric;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT id,tenant_id,branch_id,product_id,status INTO _o
  FROM public.production_orders WHERE id=_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production order not found'; END IF;
  IF NOT public.has_branch_role(_user_id,_o.tenant_id,_o.branch_id,
    ARRAY['owner','admin','manager','kitchen']::public.app_role[])
  THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF _produced IS NULL OR _produced < 0 OR _produced <> round(_produced,3)
  THEN RAISE EXCEPTION 'Produced quantity must be non-negative with at most three decimal places'; END IF;
  IF COALESCE(_waste,0) < 0 OR COALESCE(_waste,0) <> round(COALESCE(_waste,0),3)
  THEN RAISE EXCEPTION 'Waste quantity must be non-negative with at most three decimal places'; END IF;

  SELECT id INTO _center_id FROM public.inventory_centers
  WHERE tenant_id=_o.tenant_id AND branch_id=_o.branch_id AND status='active'
  ORDER BY (name='Bodega Principal') DESC, created_at, id LIMIT 1;
  IF _center_id IS NULL THEN RAISE EXCEPTION 'No active inventory center exists for production branch'; END IF;

  _request := jsonb_build_object('order_id',_order_id,'produced',_produced,
    'waste',COALESCE(_waste,0),'inventory_center_id',_center_id);
  SELECT * INTO _claim FROM public.claim_inventory_operation_v2(
    _o.tenant_id,_o.branch_id,'production_complete',_client_mutation_id,_request);
  _operation_id := _claim.operation_id;
  IF _claim.is_replay THEN RETURN _operation_id; END IF;
  IF _o.status='completed' THEN RAISE EXCEPTION 'Production order is already completed under another operation'; END IF;

  FOR _comp IN SELECT component_product_id,quantity,COALESCE(waste_pct,0) AS waste_pct
    FROM public.product_components WHERE parent_product_id=_o.product_id ORDER BY id
  LOOP
    _consumed := _comp.quantity * _produced * (1 + _comp.waste_pct / 100.0);
    IF _consumed > 0 THEN
      PERFORM public.apply_inventory_movement(_o.tenant_id,_o.branch_id,_comp.component_product_id,
        'consumption'::public.movement_type,_consumed,'Production order','inventory_operation',
        _operation_id,_user_id,_center_id);
      INSERT INTO public.production_consumptions(tenant_id,order_id,product_id,quantity)
      VALUES (_o.tenant_id,_order_id,_comp.component_product_id,_consumed);
    END IF;
  END LOOP;
  IF _produced > 0 THEN
    PERFORM public.apply_inventory_movement(_o.tenant_id,_o.branch_id,_o.product_id,
      'production'::public.movement_type,_produced,'Production output','inventory_operation',
      _operation_id,_user_id,_center_id);
  END IF;
  UPDATE public.production_orders SET status='completed',produced_quantity=_produced,
    waste_quantity=COALESCE(_waste,0),completed_at=now(),user_id=_user_id WHERE id=_order_id;
  UPDATE public.inventory_operations SET status='completed',completed_at=now() WHERE id=_operation_id;
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.audit_logs (tenant_id,user_id,action,entity,entity_id,metadata) VALUES ($1,$2,$3,$4,$5,$6)'
    USING _o.tenant_id,_user_id,'production.completed_v2','inventory_operations',_operation_id,
      jsonb_build_object('branch_id',_o.branch_id,'production_order_id',_order_id,'produced',_produced,
        'waste',COALESCE(_waste,0),'client_mutation_id',_client_mutation_id);
  END IF;
  RETURN _operation_id;
END; $$;

CREATE OR REPLACE FUNCTION public.require_inventory_device_v1(
  _tenant_id uuid, _branch_id uuid, _device_uid text, _device_credential text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _user_id uuid := auth.uid(); _device_id uuid;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _device_uid IS NULL OR btrim(_device_uid)='' OR _device_credential IS NULL
     OR length(_device_credential)<>64 OR _device_credential !~ '^[0-9a-fA-F]{64}$'
  THEN RAISE EXCEPTION 'Device credential required' USING ERRCODE='42501'; END IF;
  SELECT d.id INTO _device_id FROM public.devices d
   WHERE d.tenant_id=_tenant_id AND d.branch_id=_branch_id AND d.device_uid=btrim(_device_uid)
     AND d.revoked_at IS NULL AND d.credential_hash=extensions.digest(convert_to(_device_credential,'UTF8'),'sha256')
   FOR UPDATE;
  IF _device_id IS NULL THEN RAISE EXCEPTION 'Device credential rejected' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id=_branch_id AND b.tenant_id=_tenant_id AND b.status='active'
  ) THEN RAISE EXCEPTION 'Inventory branch is invalid or inactive' USING ERRCODE='42501'; END IF;
  IF NOT public.has_branch_role(_user_id,_tenant_id,_branch_id,ARRAY['owner','admin','manager','inventory','kitchen']::public.app_role[])
  THEN RAISE EXCEPTION 'Device operator not authorized' USING ERRCODE='42501'; END IF;
  RETURN _device_id;
END; $$;
REVOKE ALL ON FUNCTION public.require_inventory_device_v1(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.record_inventory_batch_v3_device(
  _tenant_id uuid, _branch_id uuid, _inventory_center_id uuid, _movements jsonb,
  _client_mutation_id text, _reason text, _device_uid text, _device_credential text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.require_inventory_device_v1(_tenant_id,_branch_id,_device_uid,_device_credential);
  RETURN public.record_inventory_batch_v2(_tenant_id,_branch_id,_inventory_center_id,_movements,_client_mutation_id,_reason);
END; $$;

CREATE OR REPLACE FUNCTION public.reconcile_inventory_levels_v3_device(
  _tenant_id uuid, _branch_id uuid, _inventory_center_id uuid, _targets jsonb,
  _client_mutation_id text, _reason text, _device_uid text, _device_credential text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.require_inventory_device_v1(_tenant_id,_branch_id,_device_uid,_device_credential);
  RETURN public.reconcile_inventory_levels_v2(_tenant_id,_branch_id,_inventory_center_id,_targets,_client_mutation_id,_reason);
END; $$;

CREATE OR REPLACE FUNCTION public.transfer_inventory_v3_device(
  _tenant_id uuid, _branch_id uuid, _product_id uuid, _from_center_id uuid,
  _to_center_id uuid, _quantity numeric, _reason text, _client_mutation_id text,
  _device_uid text, _device_credential text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.require_inventory_device_v1(_tenant_id,_branch_id,_device_uid,_device_credential);
  RETURN public.transfer_inventory_v2(_tenant_id,_branch_id,_product_id,_from_center_id,_to_center_id,_quantity,_reason,_client_mutation_id);
END; $$;

CREATE OR REPLACE FUNCTION public.receive_purchase_order_v3_device(
  _tenant_id uuid, _branch_id uuid, _order_id uuid, _inventory_center_id uuid,
  _client_mutation_id text, _device_uid text, _device_credential text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.require_inventory_device_v1(_tenant_id,_branch_id,_device_uid,_device_credential);
  IF NOT EXISTS (SELECT 1 FROM public.purchase_orders p WHERE p.id=_order_id AND p.tenant_id=_tenant_id AND p.branch_id=_branch_id)
  THEN RAISE EXCEPTION 'Purchase order scope mismatch' USING ERRCODE='42501'; END IF;
  RETURN public.receive_purchase_order_v2(_order_id,_inventory_center_id,_client_mutation_id);
END; $$;

CREATE OR REPLACE FUNCTION public.complete_production_order_v3_device(
  _tenant_id uuid, _branch_id uuid, _order_id uuid, _produced numeric, _waste numeric,
  _client_mutation_id text, _device_uid text, _device_credential text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.require_inventory_device_v1(_tenant_id,_branch_id,_device_uid,_device_credential);
  IF NOT EXISTS (SELECT 1 FROM public.production_orders p WHERE p.id=_order_id AND p.tenant_id=_tenant_id AND p.branch_id=_branch_id)
  THEN RAISE EXCEPTION 'Production order scope mismatch' USING ERRCODE='42501'; END IF;
  RETURN public.complete_production_order_v2(_order_id,_produced,_waste,_client_mutation_id);
END; $$;

REVOKE ALL ON FUNCTION public.record_inventory_batch_v2(uuid,uuid,uuid,jsonb,text,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.reconcile_inventory_levels_v2(uuid,uuid,uuid,jsonb,text,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.transfer_inventory_v2(uuid,uuid,uuid,uuid,uuid,numeric,text,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.receive_purchase_order_v2(uuid,uuid,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.complete_production_order_v2(uuid,numeric,numeric,text) FROM authenticated;

REVOKE ALL ON FUNCTION public.record_inventory_batch_v3_device(uuid,uuid,uuid,jsonb,text,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.reconcile_inventory_levels_v3_device(uuid,uuid,uuid,jsonb,text,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.transfer_inventory_v3_device(uuid,uuid,uuid,uuid,uuid,numeric,text,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.receive_purchase_order_v3_device(uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.complete_production_order_v3_device(uuid,uuid,uuid,numeric,numeric,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_inventory_batch_v3_device(uuid,uuid,uuid,jsonb,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_inventory_levels_v3_device(uuid,uuid,uuid,jsonb,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_inventory_v3_device(uuid,uuid,uuid,uuid,uuid,numeric,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order_v3_device(uuid,uuid,uuid,uuid,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_production_order_v3_device(uuid,uuid,uuid,numeric,numeric,text,text,text) TO authenticated;
COMMIT;
