-- P0 SEC-004: supplier payments require the native-held device credential.
-- Device authority and supplier scope are checked before replay or financial effect.
BEGIN;

CREATE OR REPLACE FUNCTION public.record_supplier_payment_v2_device(
  _tenant_id uuid,
  _branch_id uuid,
  _supplier_id uuid,
  _amount_fils bigint,
  _payment_method text,
  _payment_reference text,
  _note text,
  _operation_id text,
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
    SELECT 1 FROM public.suppliers s
    WHERE s.id = _supplier_id
      AND s.tenant_id = _tenant_id
  ) THEN
    RAISE EXCEPTION 'Supplier scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN public.record_supplier_payment_v1(
    _tenant_id, _branch_id, _supplier_id, _amount_fils,
    _payment_method, _payment_reference, _note, _operation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_supplier_payment_v1(uuid,uuid,uuid,bigint,text,text,text,text)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_supplier_payment_v2_device(uuid,uuid,uuid,bigint,text,text,text,text,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_supplier_payment_v2_device(uuid,uuid,uuid,bigint,text,text,text,text,text,text)
TO authenticated;

COMMENT ON FUNCTION public.record_supplier_payment_v2_device(uuid,uuid,uuid,bigint,text,text,text,text,text,text) IS
  'Native-device-bound supplier payment. Device, tenant, branch and supplier scope are verified before replay or financial effect.';

COMMIT;
