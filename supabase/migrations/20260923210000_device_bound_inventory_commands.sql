-- P0: all authoritative inventory financial mutations require a native-held
-- trusted-terminal credential. Existing v2 routines remain private atomic cores.
BEGIN;

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
