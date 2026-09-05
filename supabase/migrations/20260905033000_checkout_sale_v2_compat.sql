-- ZAIPOS P0.3 compatibility cutover.
--
-- Existing installed POS clients still call checkout_sale with decimal-shaped
-- payloads. Keep that public RPC signature stable, but make it a thin adapter
-- into checkout_sale_v2 so current terminals immediately receive server-resolved
-- pricing/tax, exact fils reconciliation, tenant checks and v2 idempotency.

BEGIN;

CREATE OR REPLACE FUNCTION public.checkout_sale(
  _tenant_id uuid,
  _branch_id uuid,
  _items jsonb,
  _payments jsonb,
  _discount_total numeric DEFAULT 0,
  _notes text DEFAULT NULL,
  _customer_id uuid DEFAULT NULL,
  _channel public.sales_channel DEFAULT 'pos',
  _tip_amount numeric DEFAULT 0,
  _coupon_code text DEFAULT NULL,
  _client_mutation_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _dev_mode boolean := false;
  _cash_session_id uuid;
  _open_session_count integer := 0;
  _items_v2 jsonb := '[]'::jsonb;
  _payments_v2 jsonb := '[]'::jsonb;
  _item jsonb;
  _payment jsonb;
  _operation_id text;
  _discount_fils bigint;
  _tip_fils bigint;
  _amount_fils bigint;
  _line_discount_fils bigint;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.has_branch_role(
    _user_id,
    _tenant_id,
    _branch_id,
    ARRAY['owner','admin','manager','cashier','waiter']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF _items IS NULL OR jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Sale must contain at least one item';
  END IF;

  _payments := COALESCE(_payments, '[]'::jsonb);
  IF jsonb_typeof(_payments) <> 'array' THEN
    RAISE EXCEPTION 'Payments must be a JSON array';
  END IF;

  SELECT COALESCE(dev_mode, false)
  INTO _dev_mode
  FROM public.tenants
  WHERE id = _tenant_id;

  IF _channel IN ('pos','tables') THEN
    SELECT count(*)::integer
    INTO _open_session_count
    FROM public.cash_sessions
    WHERE tenant_id = _tenant_id
      AND branch_id = _branch_id
      AND status = 'open';

    IF _open_session_count = 0 THEN
      _cash_session_id := NULL;
      IF NOT _dev_mode THEN
        RAISE EXCEPTION 'Checkout requires an open cash session for this branch';
      END IF;
    ELSIF _open_session_count > 1 THEN
      RAISE EXCEPTION 'Multiple open cash sessions exist for this branch; resolve the register state before checkout';
    ELSE
      SELECT id
      INTO _cash_session_id
      FROM public.cash_sessions
      WHERE tenant_id = _tenant_id
        AND branch_id = _branch_id
        AND status = 'open'
      LIMIT 1;
    END IF;
  ELSE
    _cash_session_id := NULL;
  END IF;

  FOR _item IN SELECT * FROM jsonb_array_elements(_items) LOOP
    BEGIN
      _line_discount_fils := public.bhd_numeric_to_fils(
        COALESCE(NULLIF(_item->>'discount', '')::numeric, 0)
      );
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Line discount must be a valid BHD amount';
    END;

    _items_v2 := _items_v2 || jsonb_build_array(
      jsonb_build_object(
        'product_id', _item->'product_id',
        'quantity', _item->'quantity',
        'discount_fils', _line_discount_fils,
        'modifiers', COALESCE(_item->'modifiers', '[]'::jsonb)
      )
    );
  END LOOP;

  FOR _payment IN SELECT * FROM jsonb_array_elements(_payments) LOOP
    BEGIN
      _amount_fils := public.bhd_numeric_to_fils((_payment->>'amount')::numeric);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Payment amount must be a valid BHD amount';
    END;

    _payments_v2 := _payments_v2 || jsonb_build_array(
      jsonb_build_object(
        'method', _payment->'method',
        'amount_fils', _amount_fils,
        'reference', _payment->'reference'
      )
    );
  END LOOP;

  BEGIN
    _discount_fils := public.bhd_numeric_to_fils(COALESCE(_discount_total, 0));
    _tip_fils := public.bhd_numeric_to_fils(COALESCE(_tip_amount, 0));
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Discount and tip must be valid BHD amounts';
  END;

  -- Current POS clients already send a UUID mutation ID. Preserve it exactly.
  -- A generated fallback keeps non-POS legacy callers functional, but those
  -- callers do not gain retry idempotency until they send their own stable ID.
  _operation_id := COALESCE(
    NULLIF(trim(COALESCE(_client_mutation_id, '')), ''),
    gen_random_uuid()::text
  );

  RETURN public.checkout_sale_v2(
    _tenant_id,
    _branch_id,
    _items_v2,
    _payments_v2,
    _discount_fils,
    _notes,
    _customer_id,
    _channel,
    _tip_fils,
    _coupon_code,
    _operation_id,
    _cash_session_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.checkout_sale(
  uuid,
  uuid,
  jsonb,
  jsonb,
  numeric,
  text,
  uuid,
  public.sales_channel,
  numeric,
  text,
  text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.checkout_sale(
  uuid,
  uuid,
  jsonb,
  jsonb,
  numeric,
  text,
  uuid,
  public.sales_channel,
  numeric,
  text,
  text
) TO authenticated;

COMMENT ON FUNCTION public.checkout_sale(
  uuid,
  uuid,
  jsonb,
  jsonb,
  numeric,
  text,
  uuid,
  public.sales_channel,
  numeric,
  text,
  text
) IS
  'Compatibility adapter for installed clients. Discards client price/tax, converts legacy BHD amounts to fils, resolves an unambiguous branch cash session, and delegates to checkout_sale_v2.';

COMMIT;
