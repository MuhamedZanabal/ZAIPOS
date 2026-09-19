-- P0 SEC-004 Stage 4: fail closed at the checkout financial authority boundary.
-- The legacy checkout_sale_v2 surface is no longer executable by application roles.
-- Authenticated terminals must prove possession of the enrolled device credential.
BEGIN;

CREATE OR REPLACE FUNCTION public.checkout_sale_v2_device(
  _tenant_id uuid,
  _branch_id uuid,
  _items jsonb,
  _payments jsonb,
  _discount_total_fils bigint DEFAULT 0,
  _notes text DEFAULT NULL,
  _customer_id uuid DEFAULT NULL,
  _channel public.sales_channel DEFAULT 'pos',
  _tip_amount_fils bigint DEFAULT 0,
  _coupon_code text DEFAULT NULL,
  _client_mutation_id text DEFAULT NULL,
  _cash_session_id uuid DEFAULT NULL,
  _device_uid text DEFAULT NULL,
  _device_credential text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _device_id uuid;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF _device_uid IS NULL OR btrim(_device_uid) = ''
     OR _device_credential IS NULL OR length(_device_credential) <> 64
     OR _device_credential !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'Device credential required' USING ERRCODE = '42501';
  END IF;

  SELECT d.id
    INTO _device_id
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
    _user_id,
    _tenant_id,
    _branch_id,
    ARRAY['owner','admin','manager','cashier','waiter']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Device operator not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN public.checkout_sale_v2(
    _tenant_id,
    _branch_id,
    _items,
    _payments,
    _discount_total_fils,
    _notes,
    _customer_id,
    _channel,
    _tip_amount_fils,
    _coupon_code,
    _client_mutation_id,
    _cash_session_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.checkout_sale_v2(uuid, uuid, jsonb, jsonb, bigint, text, uuid, public.sales_channel, bigint, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkout_sale(uuid, uuid, jsonb, jsonb, numeric, text, uuid, public.sales_channel, numeric, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkout_sale_v2_device(uuid, uuid, jsonb, jsonb, bigint, text, uuid, public.sales_channel, bigint, text, text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.checkout_sale_v2_device(uuid, uuid, jsonb, jsonb, bigint, text, uuid, public.sales_channel, bigint, text, text, uuid, text, text) TO authenticated;

COMMIT;
