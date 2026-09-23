-- P0 SEC-004: customer-credit payments require the native-held device credential.
-- Device authority and customer scope are checked before replay or financial effect.
BEGIN;

CREATE OR REPLACE FUNCTION public.record_customer_credit_payment_v2_device(
  _tenant_id uuid,
  _branch_id uuid,
  _customer_id uuid,
  _amount_fils bigint,
  _payment_method text,
  _payment_reference text,
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
    SELECT 1 FROM public.customers c
    WHERE c.id = _customer_id
      AND c.tenant_id = _tenant_id
  ) THEN
    RAISE EXCEPTION 'Customer scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN public.record_customer_credit_payment_v1(
    _customer_id, _amount_fils, _payment_method, _payment_reference, _operation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_customer_credit_payment_v1(uuid,bigint,text,text,text)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_customer_credit_payment_v2_device(uuid,uuid,uuid,bigint,text,text,text,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_customer_credit_payment_v2_device(uuid,uuid,uuid,bigint,text,text,text,text,text)
TO authenticated;

COMMENT ON FUNCTION public.record_customer_credit_payment_v2_device(uuid,uuid,uuid,bigint,text,text,text,text,text) IS
  'Native-device-bound customer-credit payment. Device, tenant, branch and customer scope are verified before replay or financial effect.';

COMMIT;
