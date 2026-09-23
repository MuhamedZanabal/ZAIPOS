-- P0 SEC-004: sale returns and voids require the native-held device credential.
-- Device authority is checked before sale lookup, replay, or financial effect.
BEGIN;

CREATE OR REPLACE FUNCTION public.process_sale_return_v3_device(
  _tenant_id uuid,
  _branch_id uuid,
  _sale_id uuid,
  _items jsonb,
  _reason_code text,
  _client_mutation_id text,
  _cash_session_id uuid,
  _reason text,
  _evidence_url text,
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
    SELECT 1 FROM public.sales s
    WHERE s.id = _sale_id
      AND s.tenant_id = _tenant_id
      AND s.branch_id = _branch_id
  ) THEN
    RAISE EXCEPTION 'Sale scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN public.process_sale_return_v2(
    _sale_id, _items, _reason_code, _client_mutation_id,
    _cash_session_id, _reason, _evidence_url
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_sale_void_v3_device(
  _tenant_id uuid,
  _branch_id uuid,
  _sale_id uuid,
  _client_mutation_id text,
  _cash_session_id uuid,
  _reason text,
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
    SELECT 1 FROM public.sales s
    WHERE s.id = _sale_id
      AND s.tenant_id = _tenant_id
      AND s.branch_id = _branch_id
  ) THEN
    RAISE EXCEPTION 'Sale scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN public.process_sale_void_v2(
    _sale_id, _client_mutation_id, _cash_session_id, _reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_sale_return_v2(uuid,jsonb,text,text,uuid,text,text)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_sale_void_v2(uuid,text,uuid,text)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_sale_return_v3_device(uuid,uuid,uuid,jsonb,text,text,uuid,text,text,text,text)
FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.process_sale_void_v3_device(uuid,uuid,uuid,text,uuid,text,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_sale_return_v3_device(uuid,uuid,uuid,jsonb,text,text,uuid,text,text,text,text)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_sale_void_v3_device(uuid,uuid,uuid,text,uuid,text,text,text)
TO authenticated;

COMMENT ON FUNCTION public.process_sale_return_v3_device(uuid,uuid,uuid,jsonb,text,text,uuid,text,text,text,text) IS
  'Native-device-bound sale return. Device, tenant, branch and sale scope are verified before replay or financial effect.';
COMMENT ON FUNCTION public.process_sale_void_v3_device(uuid,uuid,uuid,text,uuid,text,text,text) IS
  'Native-device-bound sale void. Device, tenant, branch and sale scope are verified before replay or financial effect.';

COMMIT;
