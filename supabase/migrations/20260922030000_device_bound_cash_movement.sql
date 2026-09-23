-- P0 SEC-004: manual cash movements require the native-held device credential.
-- Legacy v2 routines remain the centralized exact-fils/idempotency primitives,
-- but authenticated clients may only reach them through these device wrappers.
BEGIN;

CREATE OR REPLACE FUNCTION public.require_financial_device_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _device_uid text,
  _device_credential text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
  FROM public.devices d
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
    ARRAY['owner','admin','manager','cashier']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Device operator not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN _device_id;
END;
$$;

REVOKE ALL ON FUNCTION public.require_financial_device_v1(uuid,uuid,text,text)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_cash_movement_v3_device(
  _tenant_id uuid,
  _branch_id uuid,
  _session_id uuid,
  _type text,
  _amount numeric,
  _reason text,
  _reference text,
  _device_uid text,
  _device_credential text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.require_financial_device_v1(
    _tenant_id, _branch_id, _device_uid, _device_credential
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.cash_sessions s
    WHERE s.id = _session_id
      AND s.tenant_id = _tenant_id
      AND s.branch_id = _branch_id
  ) THEN
    RAISE EXCEPTION 'Cash session scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN public.record_cash_movement_v2(
    _session_id, _type, _amount, _reason, _reference
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_cash_movement_v3_device(
  _tenant_id uuid,
  _branch_id uuid,
  _session_id uuid,
  _type text,
  _amount numeric,
  _reason text,
  _reference text,
  _device_uid text,
  _device_credential text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.require_financial_device_v1(
    _tenant_id, _branch_id, _device_uid, _device_credential
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.cash_sessions s
    WHERE s.id = _session_id
      AND s.tenant_id = _tenant_id
      AND s.branch_id = _branch_id
  ) THEN
    RAISE EXCEPTION 'Cash session scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN public.cancel_cash_movement_v2(
    _session_id, _type, _amount, _reason, _reference
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_cash_movement_v2(uuid,text,numeric,text,text)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_cash_movement_v2(uuid,text,numeric,text,text)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_cash_movement_v3_device(uuid,uuid,uuid,text,numeric,text,text,text,text)
FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_cash_movement_v3_device(uuid,uuid,uuid,text,numeric,text,text,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_cash_movement_v3_device(uuid,uuid,uuid,text,numeric,text,text,text,text)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_cash_movement_v3_device(uuid,uuid,uuid,text,numeric,text,text,text,text)
TO authenticated;

COMMENT ON FUNCTION public.record_cash_movement_v3_device(uuid,uuid,uuid,text,numeric,text,text,text,text) IS
  'Native-device-bound exactly-once manual cash movement. Credential is verified before replay or any financial effect.';
COMMENT ON FUNCTION public.cancel_cash_movement_v3_device(uuid,uuid,uuid,text,numeric,text,text,text,text) IS
  'Native-device-bound cash movement cancellation/observation. Credential is verified before the immutable reference is claimed or observed.';

COMMIT;
