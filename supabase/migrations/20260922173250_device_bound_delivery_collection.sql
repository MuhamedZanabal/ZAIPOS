-- Delivery collection is a financial mutation and must originate from an
-- approved terminal. The legacy function remains an internal implementation
-- detail so its atomic/idempotent accounting contract is preserved.
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
  PERFORM public.require_financial_device_v1(
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
