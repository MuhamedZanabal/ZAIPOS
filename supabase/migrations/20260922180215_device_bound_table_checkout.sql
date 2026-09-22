-- Restaurant table checkout is a sale and must originate from an approved
-- terminal. The existing function remains the atomic checkout primitive.
BEGIN;

CREATE OR REPLACE FUNCTION public.require_table_checkout_device_v1(
  _tenant_id uuid, _branch_id uuid, _device_uid text, _device_credential text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  _user_id uuid := auth.uid();
  _device_id uuid;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
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
    ARRAY['owner','admin','manager','cashier','waiter']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Table checkout operator not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN _device_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.require_table_checkout_device_v1(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.checkout_table_order_v2_device(
  _tenant_id uuid,
  _branch_id uuid,
  _order_id uuid,
  _payments jsonb,
  _tip_amount numeric,
  _discount_total numeric,
  _coupon_code text,
  _client_mutation_id text,
  _device_uid text,
  _device_credential text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  _order public.table_orders;
  _items jsonb;
  _sale_id uuid;
BEGIN
  PERFORM public.require_table_checkout_device_v1(_tenant_id, _branch_id, _device_uid, _device_credential);
  SELECT * INTO _order FROM public.table_orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND OR _order.tenant_id IS DISTINCT FROM _tenant_id OR _order.branch_id IS DISTINCT FROM _branch_id THEN
    RAISE EXCEPTION 'Table order is outside the authorized device scope' USING ERRCODE = '42501';
  END IF;
  IF _client_mutation_id IS NULL OR length(btrim(_client_mutation_id)) < 8 OR length(_client_mutation_id) > 200 THEN
    RAISE EXCEPTION 'Table checkout operation ID required';
  END IF;

  -- A committed response may be lost after the legacy table function closes
  -- the order. Re-enter the exact checkout core only for its already-completed
  -- operation so it can return the original sale or reject payload substitution.
  IF _order.status = 'closed' AND _order.sale_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.checkout_operations AS op
    WHERE op.tenant_id = _tenant_id
      AND op.client_mutation_id = btrim(_client_mutation_id)
      AND op.status = 'completed'
      AND op.sale_id = _order.sale_id
  ) THEN
    SELECT jsonb_agg(jsonb_build_object(
      'product_id', product_id, 'quantity', quantity, 'unit_price', unit_price,
      'tax_rate', tax_rate, 'discount', discount, 'modifiers', modifiers
    )) INTO _items
    FROM public.table_order_items
    WHERE order_id = _order_id AND status = 'dispatched';

    _sale_id := public.checkout_sale(
      _tenant_id, _branch_id, _items, _payments, _discount_total,
      COALESCE(_order.notes, '') || ' [Mesa]', NULL, 'tables'::public.sales_channel,
      _tip_amount, _coupon_code, btrim(_client_mutation_id)
    );
    IF _sale_id IS DISTINCT FROM _order.sale_id THEN
      RAISE EXCEPTION 'Table checkout replay returned a different sale';
    END IF;
    RETURN _sale_id;
  END IF;

  RETURN public.checkout_table_order(
    _order_id, _payments, _tip_amount, _discount_total, _coupon_code, _client_mutation_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.checkout_table_order(uuid, jsonb, numeric, numeric, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkout_table_order_v2_device(uuid, uuid, uuid, jsonb, numeric, numeric, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.checkout_table_order_v2_device(uuid, uuid, uuid, jsonb, numeric, numeric, text, text, text, text) TO authenticated;

COMMIT;
