-- Digital orders: accept Talabat.
--
-- The 'talabat' sales channel was added in 20260904000100, but
-- register_digital_order still only accepted the inherited LatAm channels, so
-- recording a Talabat order failed with 'Invalid digital channel'.
-- Same function body; only the channel check changes.
CREATE OR REPLACE FUNCTION public.register_digital_order(
  _tenant_id uuid,
  _branch_id uuid,
  _channel public.sales_channel,
  _external_no text,
  _items jsonb,
  _commission numeric DEFAULT 0,
  _notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _order_id uuid;
  _item jsonb;
  _product record;
  _line_total numeric;
  _gross numeric := 0;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(_user_id, _tenant_id, _branch_id, ARRAY['owner','admin','manager','cashier']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF _channel NOT IN ('talabat','rappi','delivery','whatsapp','didi','uber') THEN
    RAISE EXCEPTION 'Invalid digital channel';
  END IF;
  IF _items IS NULL OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'El pedido digital no tiene items';
  END IF;

  INSERT INTO public.digital_orders
    (tenant_id, branch_id, channel, external_order_number, gross_total, platform_commission, net_total, status, notes, user_id)
  VALUES
    (_tenant_id, _branch_id, _channel, NULLIF(_external_no, ''), 0, COALESCE(_commission, 0), 0, 'received', _notes, _user_id)
  RETURNING id INTO _order_id;

  FOR _item IN SELECT * FROM jsonb_array_elements(_items) LOOP
    SELECT id, name, tax_rate INTO _product
    FROM public.products
    WHERE id = (_item->>'product_id')::uuid AND tenant_id = _tenant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', _item->>'product_id'; END IF;

    _line_total :=
      ((_item->>'quantity')::numeric * (_item->>'unit_price')::numeric)
      - COALESCE((_item->>'discount')::numeric, 0);
    _line_total := _line_total + (_line_total * COALESCE((_item->>'tax_rate')::numeric, _product.tax_rate, 0) / 100.0);
    _gross := _gross + _line_total;

    INSERT INTO public.digital_order_items
      (tenant_id, digital_order_id, product_id, product_name, quantity, unit_price, tax_rate, discount, line_total, raw_payload)
    VALUES
      (_tenant_id, _order_id, _product.id, _product.name,
       (_item->>'quantity')::numeric, (_item->>'unit_price')::numeric,
       COALESCE((_item->>'tax_rate')::numeric, _product.tax_rate, 0),
       COALESCE((_item->>'discount')::numeric, 0), _line_total, _item);
  END LOOP;

  UPDATE public.digital_orders
     SET gross_total = _gross,
         net_total = GREATEST(_gross - COALESCE(_commission, 0), 0)
   WHERE id = _order_id;

  RETURN _order_id;
END;
$$;
