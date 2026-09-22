-- Delivery collection is a financial mutation and must originate from an
-- approved terminal. The legacy function remains an internal implementation
-- detail so its atomic/idempotent accounting contract is preserved.
BEGIN;

CREATE OR REPLACE FUNCTION public.require_delivery_collection_device_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _device_uid text,
  _device_credential text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  _user_id uuid := auth.uid();
  _device_id uuid;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF _tenant_id IS NULL OR _branch_id IS NULL
     OR _device_uid IS NULL OR btrim(_device_uid) = ''
     OR _device_credential IS NULL OR length(_device_credential) <> 64
     OR _device_credential !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'Device credential required' USING ERRCODE = '42501';
  END IF;

  SELECT d.id INTO _device_id
  FROM public.devices AS d
  WHERE d.tenant_id = _tenant_id
    AND d.branch_id = _branch_id
    AND d.device_uid = btrim(_device_uid)
    AND d.revoked_at IS NULL
    AND d.credential_hash IS NOT NULL
    AND d.credential_hash = extensions.digest(convert_to(_device_credential, 'UTF8'), 'sha256')
  FOR UPDATE;

  IF _device_id IS NULL THEN
    RAISE EXCEPTION 'Device credential rejected' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_branch_role(
    _user_id, _tenant_id, _branch_id,
    ARRAY['owner','admin','manager','cashier','courier']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Delivery collection operator not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN _device_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.require_delivery_collection_device_v1(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.collect_delivery_payment_v3_device(
  _tenant_id uuid,
  _branch_id uuid,
  _order_id uuid,
  _method public.payment_method,
  _session_id uuid,
  _client_mutation_id text,
  _reference text,
  _device_uid text,
  _device_credential text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  _actual_tenant uuid;
  _actual_branch uuid;
BEGIN
  PERFORM public.require_delivery_collection_device_v1(
    _tenant_id,
    _branch_id,
    _device_uid,
    _device_credential
  );

  SELECT d.tenant_id, d.branch_id
    INTO _actual_tenant, _actual_branch
  FROM public.delivery_orders AS d
  WHERE d.id = _order_id;

  IF NOT FOUND OR _actual_tenant IS DISTINCT FROM _tenant_id OR _actual_branch IS DISTINCT FROM _branch_id THEN
    RAISE EXCEPTION 'Delivery order is outside the authorized device scope';
  END IF;

  RETURN public.collect_delivery_payment_v2(
    _order_id,
    _method,
    _session_id,
    _client_mutation_id,
    _reference
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.collect_delivery_payment_v2(uuid, public.payment_method, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collect_delivery_payment_v3_device(uuid, uuid, uuid, public.payment_method, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collect_delivery_payment_v3_device(uuid, uuid, uuid, public.payment_method, uuid, text, text, text, text) TO authenticated;

COMMIT;
