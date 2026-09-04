-- ZAIPOS P0 transaction-core foundation.
-- Bahrain money is quantized to integer fils for all checkout arithmetic.
-- Existing numeric columns remain as the compatibility API but are widened to 3 decimals
-- and receive generated *_fils shadow columns on the core transaction tables.

CREATE OR REPLACE FUNCTION public.bhd_to_fils(_amount numeric)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT round(_amount * 1000)::bigint;
$$;

CREATE OR REPLACE FUNCTION public.fils_to_bhd(_amount_fils bigint)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT (_amount_fils::numeric / 1000)::numeric(18,3);
$$;

-- Correct inherited two-decimal / unconstrained money columns without breaking
-- existing client column names. Conditional execution keeps upgrade paths resilient.
DO $$
DECLARE
  _entry record;
BEGIN
  FOR _entry IN
    SELECT * FROM (VALUES
      ('products','price'), ('products','cost'),
      ('branch_products','local_price'), ('product_channel_prices','price'),
      ('modifier_options','price_delta'), ('discount_codes','discount_value'),
      ('sales','subtotal'), ('sales','tax_total'), ('sales','discount_total'), ('sales','total'), ('sales','tip_amount'),
      ('sale_items','unit_price'), ('sale_items','discount'), ('sale_items','line_total'),
      ('payments','amount'),
      ('cash_sessions','opening_amount'), ('cash_sessions','closing_amount'), ('cash_sessions','expected_amount'), ('cash_sessions','difference'),
      ('cash_sessions','total_cash'), ('cash_sessions','total_card'), ('cash_sessions','total_transfer'), ('cash_sessions','total_qr'),
      ('cash_sessions','total_in'), ('cash_sessions','total_out'),
      ('cash_sessions','counted_cash'), ('cash_sessions','counted_card'), ('cash_sessions','counted_transfer'), ('cash_sessions','counted_qr'),
      ('cash_movements','amount'),
      ('table_orders','subtotal'), ('table_orders','tax_total'), ('table_orders','discount_total'), ('table_orders','total'),
      ('table_order_items','unit_price'), ('table_order_items','discount'), ('table_order_items','line_total'),
      ('digital_orders','gross_total'), ('digital_orders','platform_commission'), ('digital_orders','net_total'),
      ('digital_order_items','unit_price'), ('digital_order_items','discount'), ('digital_order_items','line_total'),
      ('purchase_orders','total'), ('purchase_order_items','cost_price'), ('purchase_order_items','line_total'),
      ('expenses','amount'), ('sale_returns','amount')
    ) AS v(table_name, column_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = _entry.table_name
        AND column_name = _entry.column_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I TYPE numeric(18,3) USING round(%I::numeric, 3)',
        _entry.table_name, _entry.column_name, _entry.column_name
      );
    END IF;
  END LOOP;
END $$;

-- Exact generated fils projections make transaction invariants queryable and auditable
-- while preserving the existing numeric API for current application code.
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS subtotal_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(subtotal)) STORED,
  ADD COLUMN IF NOT EXISTS tax_total_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(tax_total)) STORED,
  ADD COLUMN IF NOT EXISTS discount_total_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(discount_total)) STORED,
  ADD COLUMN IF NOT EXISTS total_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(total)) STORED,
  ADD COLUMN IF NOT EXISTS tip_amount_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(tip_amount)) STORED;

ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS unit_price_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(unit_price)) STORED,
  ADD COLUMN IF NOT EXISTS discount_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(discount)) STORED,
  ADD COLUMN IF NOT EXISTS line_total_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(line_total)) STORED;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS amount_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(amount)) STORED;

ALTER TABLE public.cash_sessions
  ADD COLUMN IF NOT EXISTS opening_amount_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(opening_amount)) STORED,
  ADD COLUMN IF NOT EXISTS total_cash_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(total_cash)) STORED,
  ADD COLUMN IF NOT EXISTS total_card_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(total_card)) STORED,
  ADD COLUMN IF NOT EXISTS total_transfer_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(total_transfer)) STORED,
  ADD COLUMN IF NOT EXISTS total_qr_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(total_qr)) STORED,
  ADD COLUMN IF NOT EXISTS total_in_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(total_in)) STORED,
  ADD COLUMN IF NOT EXISTS total_out_fils bigint GENERATED ALWAYS AS (public.bhd_to_fils(total_out)) STORED;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_amount_positive') THEN
    ALTER TABLE public.payments ADD CONSTRAINT payments_amount_positive CHECK (amount_fils > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_money_nonnegative') THEN
    ALTER TABLE public.sales ADD CONSTRAINT sales_money_nonnegative CHECK (
      subtotal_fils >= 0 AND tax_total_fils >= 0 AND discount_total_fils >= 0 AND total_fils >= 0 AND tip_amount_fils >= 0
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_items_money_valid') THEN
    ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_money_valid CHECK (
      quantity > 0 AND unit_price_fils >= 0 AND discount_fils >= 0 AND line_total_fils >= 0
    ) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.checkout_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  client_mutation_id text NOT NULL,
  request_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed')),
  sale_id uuid REFERENCES public.sales(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, client_mutation_id),
  CHECK (length(trim(client_mutation_id)) >= 8),
  CHECK ((status = 'completed' AND sale_id IS NOT NULL AND completed_at IS NOT NULL) OR status = 'processing')
);

CREATE INDEX IF NOT EXISTS idx_checkout_operations_sale ON public.checkout_operations(sale_id);
CREATE INDEX IF NOT EXISTS idx_checkout_operations_created ON public.checkout_operations(tenant_id, created_at DESC);

ALTER TABLE public.checkout_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checkout_operations_admin_select ON public.checkout_operations;
CREATE POLICY checkout_operations_admin_select
ON public.checkout_operations
FOR SELECT TO authenticated
USING (public.has_any_role(auth.uid(), tenant_id, ARRAY['owner','admin','manager']::public.app_role[]));

-- The old signature is intentionally removed so PostgREST cannot resolve an unsafe
-- checkout implementation alongside the new exact-session contract.
DROP FUNCTION IF EXISTS public.checkout_sale(
  uuid, uuid, jsonb, jsonb, numeric, text, uuid, public.sales_channel, numeric, text, text
);

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
  _client_mutation_id text DEFAULT NULL,
  _cash_session_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _session_id uuid;
  _sale_id uuid;
  _existing_sale_id uuid;
  _operation_id uuid;
  _operation public.checkout_operations;
  _request_payload jsonb;
  _subtotal_fils bigint := 0;
  _tax_total_fils bigint := 0;
  _coupon_discount_fils bigint := 0;
  _tip_fils bigint := 0;
  _total_fils bigint := 0;
  _payment_total_fils bigint := 0;
  _item jsonb;
  _pay jsonb;
  _quantity numeric;
  _line_discount_fils bigint;
  _unit_price_fils bigint;
  _modifier_delta_fils bigint;
  _line_subtotal_fils bigint;
  _line_tax_fils bigint;
  _line_total_fils bigint;
  _product record;
  _component record;
  _coupon public.discount_codes;
  _points_config integer;
  _points_earned integer;
  _dev_mode boolean := false;
  _open_session_count integer := 0;
  _modifier_requested integer;
  _modifier_valid integer;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.has_branch_role(_user_id, _tenant_id, _branch_id, ARRAY['owner','admin','manager','cashier','waiter']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = _branch_id AND tenant_id = _tenant_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Branch is not active for this business';
  END IF;
  IF _items IS NULL OR jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Sale must contain at least one item';
  END IF;
  IF _payments IS NULL OR jsonb_typeof(_payments) <> 'array' THEN
    RAISE EXCEPTION 'Payments must be a JSON array';
  END IF;
  IF NULLIF(trim(COALESCE(_client_mutation_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A stable client mutation ID is required for checkout';
  END IF;
  IF length(trim(_client_mutation_id)) < 8 THEN
    RAISE EXCEPTION 'Client mutation ID is invalid';
  END IF;

  _tip_fils := public.bhd_to_fils(GREATEST(COALESCE(_tip_amount, 0), 0));
  IF COALESCE(_tip_amount, 0) < 0 THEN
    RAISE EXCEPTION 'Tip cannot be negative';
  END IF;
  IF COALESCE(_discount_total, 0) < 0 THEN
    RAISE EXCEPTION 'Discount cannot be negative';
  END IF;

  _request_payload := jsonb_build_object(
    'tenant_id', _tenant_id,
    'branch_id', _branch_id,
    'items', _items,
    'payments', _payments,
    'discount_total', public.fils_to_bhd(public.bhd_to_fils(COALESCE(_discount_total, 0))),
    'notes', _notes,
    'customer_id', _customer_id,
    'channel', _channel::text,
    'tip_amount', public.fils_to_bhd(_tip_fils),
    'coupon_code', NULLIF(upper(trim(COALESCE(_coupon_code, ''))), ''),
    'cash_session_id', _cash_session_id
  );

  -- Compatibility for checkouts committed by the prior implementation.
  SELECT id INTO _existing_sale_id
  FROM public.sales
  WHERE tenant_id = _tenant_id AND client_mutation_id = _client_mutation_id;
  IF _existing_sale_id IS NOT NULL THEN
    RETURN _existing_sale_id;
  END IF;

  -- Race-safe idempotency claim. Concurrent inserts on the unique key block until
  -- the first transaction commits/rolls back, then either replay or proceed safely.
  INSERT INTO public.checkout_operations (
    tenant_id, branch_id, user_id, client_mutation_id, request_payload, status
  ) VALUES (
    _tenant_id, _branch_id, _user_id, trim(_client_mutation_id), _request_payload, 'processing'
  )
  ON CONFLICT (tenant_id, client_mutation_id) DO NOTHING
  RETURNING id INTO _operation_id;

  IF _operation_id IS NULL THEN
    SELECT * INTO _operation
    FROM public.checkout_operations
    WHERE tenant_id = _tenant_id AND client_mutation_id = trim(_client_mutation_id)
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Could not acquire checkout idempotency record';
    END IF;
    IF _operation.request_payload IS DISTINCT FROM _request_payload THEN
      RAISE EXCEPTION 'Client mutation ID was already used for a different checkout request';
    END IF;
    IF _operation.status = 'completed' AND _operation.sale_id IS NOT NULL THEN
      RETURN _operation.sale_id;
    END IF;
    RAISE EXCEPTION 'Checkout operation is already processing';
  END IF;

  SELECT COALESCE(dev_mode, false) INTO _dev_mode
  FROM public.tenants WHERE id = _tenant_id;

  IF _channel IN ('pos','tables') THEN
    IF _cash_session_id IS NOT NULL THEN
      SELECT id INTO _session_id
      FROM public.cash_sessions
      WHERE id = _cash_session_id
        AND tenant_id = _tenant_id
        AND branch_id = _branch_id
        AND status = 'open'
      FOR UPDATE;
      IF _session_id IS NULL AND NOT _dev_mode THEN
        RAISE EXCEPTION 'The selected cash session is not open for this branch';
      END IF;
    ELSIF NOT _dev_mode THEN
      SELECT count(*) INTO _open_session_count
      FROM public.cash_sessions
      WHERE tenant_id = _tenant_id AND branch_id = _branch_id AND status = 'open';

      IF _open_session_count = 0 THEN
        RAISE EXCEPTION 'Open a cash register before completing a sale';
      ELSIF _open_session_count > 1 THEN
        RAISE EXCEPTION 'Multiple cash sessions are open; checkout must identify the exact register session';
      END IF;

      SELECT id INTO _session_id
      FROM public.cash_sessions
      WHERE tenant_id = _tenant_id AND branch_id = _branch_id AND status = 'open'
      FOR UPDATE;
    END IF;
  END IF;

  IF _customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customers WHERE id = _customer_id AND tenant_id = _tenant_id
  ) THEN
    RAISE EXCEPTION 'Customer does not belong to this business';
  END IF;

  INSERT INTO public.sales (
    tenant_id, branch_id, session_id, user_id, customer_id,
    subtotal, tax_total, discount_total, total, notes, channel,
    tip_amount, coupon_code, client_mutation_id
  ) VALUES (
    _tenant_id, _branch_id, _session_id, _user_id, _customer_id,
    0, 0, 0, 0, _notes, _channel,
    public.fils_to_bhd(_tip_fils), NULLIF(upper(trim(COALESCE(_coupon_code, ''))), ''), trim(_client_mutation_id)
  )
  RETURNING id INTO _sale_id;

  FOR _item IN SELECT * FROM jsonb_array_elements(_items) LOOP
    IF NULLIF(_item->>'product_id', '') IS NULL THEN
      RAISE EXCEPTION 'Every sale item requires a product ID';
    END IF;

    _quantity := COALESCE((_item->>'quantity')::numeric, 0);
    IF _quantity <= 0 THEN
      RAISE EXCEPTION 'Item quantity must be greater than zero';
    END IF;

    SELECT
      p.id,
      p.name,
      p.product_type,
      COALESCE(p.tax_rate, 0) AS tax_rate,
      COALESCE(
        (SELECT pcp.price FROM public.product_channel_prices pcp
          WHERE pcp.tenant_id = _tenant_id AND pcp.product_id = p.id
            AND pcp.branch_id = _branch_id AND pcp.channel = _channel
          LIMIT 1),
        (SELECT pcp.price FROM public.product_channel_prices pcp
          WHERE pcp.tenant_id = _tenant_id AND pcp.product_id = p.id
            AND pcp.branch_id IS NULL AND pcp.channel = _channel
          LIMIT 1),
        bp.local_price,
        p.price
      ) AS resolved_price
    INTO _product
    FROM public.products p
    LEFT JOIN public.branch_products bp
      ON bp.product_id = p.id AND bp.branch_id = _branch_id
    WHERE p.id = (_item->>'product_id')::uuid
      AND p.tenant_id = _tenant_id
      AND p.status = 'active'
      AND COALESCE(bp.is_available, true) = true;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % is unavailable for this branch', _item->>'product_id';
    END IF;

    _modifier_requested := jsonb_array_length(COALESCE(_item->'modifiers', '[]'::jsonb));
    _modifier_delta_fils := 0;
    _modifier_valid := 0;
    IF _modifier_requested > 0 THEN
      SELECT
        COALESCE(sum(public.bhd_to_fils(mo.price_delta)), 0),
        count(*)
      INTO _modifier_delta_fils, _modifier_valid
      FROM jsonb_array_elements(COALESCE(_item->'modifiers', '[]'::jsonb)) selected
      JOIN public.modifier_options mo ON mo.id = (selected->>'option_id')::uuid AND mo.is_available = true
      JOIN public.modifier_groups mg ON mg.id = mo.group_id
      WHERE mg.tenant_id = _tenant_id AND mg.product_id = _product.id;

      IF _modifier_valid <> _modifier_requested THEN
        RAISE EXCEPTION 'One or more product modifiers are invalid or unavailable';
      END IF;
    END IF;

    _unit_price_fils := public.bhd_to_fils(_product.resolved_price) + _modifier_delta_fils;
    IF _unit_price_fils < 0 THEN
      RAISE EXCEPTION 'Resolved product price cannot be negative';
    END IF;

    _line_discount_fils := public.bhd_to_fils(COALESCE((_item->>'discount')::numeric, 0));
    IF _line_discount_fils < 0 THEN
      RAISE EXCEPTION 'Line discount cannot be negative';
    END IF;
    IF _line_discount_fils > 0 AND NOT public.has_branch_role(
      _user_id, _tenant_id, _branch_id, ARRAY['owner','admin','manager']::public.app_role[]
    ) THEN
      RAISE EXCEPTION 'Manager authorization is required for line discounts';
    END IF;

    _line_subtotal_fils := round(_unit_price_fils::numeric * _quantity)::bigint - _line_discount_fils;
    IF _line_subtotal_fils < 0 THEN
      RAISE EXCEPTION 'Line discount cannot exceed the line subtotal';
    END IF;
    _line_tax_fils := round(_line_subtotal_fils::numeric * _product.tax_rate / 100)::bigint;
    _line_total_fils := _line_subtotal_fils + _line_tax_fils;

    INSERT INTO public.sale_items (
      tenant_id, sale_id, product_id, product_name, product_type,
      quantity, unit_price, tax_rate, discount, line_total, modifiers
    ) VALUES (
      _tenant_id, _sale_id, _product.id, _product.name, _product.product_type,
      _quantity, public.fils_to_bhd(_unit_price_fils), _product.tax_rate,
      public.fils_to_bhd(_line_discount_fils), public.fils_to_bhd(_line_total_fils),
      COALESCE(_item->'modifiers', '[]'::jsonb)
    );

    _subtotal_fils := _subtotal_fils + _line_subtotal_fils;
    _tax_total_fils := _tax_total_fils + _line_tax_fils;

    IF _product.product_type IN ('simple','production','combo') THEN
      PERFORM public.apply_inventory_movement(
        _tenant_id, _branch_id, _product.id, 'sale'::public.movement_type,
        _quantity, _channel::text || ' sale', 'sale', _sale_id, _user_id, NULL
      );
    ELSIF _product.product_type = 'composite' THEN
      FOR _component IN
        SELECT component_product_id, quantity, COALESCE(waste_pct, 0) AS waste_pct
        FROM public.product_components
        WHERE parent_product_id = _product.id
      LOOP
        PERFORM public.apply_inventory_movement(
          _tenant_id, _branch_id, _component.component_product_id, 'consumption'::public.movement_type,
          _component.quantity * _quantity * (1 + _component.waste_pct / 100.0),
          'Composite ' || _channel::text, 'sale', _sale_id, _user_id, NULL
        );
      END LOOP;
    END IF;
  END LOOP;

  IF NULLIF(trim(COALESCE(_coupon_code, '')), '') IS NOT NULL THEN
    SELECT * INTO _coupon
    FROM public.discount_codes
    WHERE tenant_id = _tenant_id
      AND upper(code) = upper(trim(_coupon_code))
      AND is_active = true
      AND starts_at <= now()
      AND (expires_at IS NULL OR expires_at >= now())
      AND (max_uses IS NULL OR current_uses < max_uses)
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Coupon is invalid, expired, or exhausted';
    END IF;

    IF _coupon.discount_type = 'percentage' THEN
      _coupon_discount_fils := round(
        (_subtotal_fils + _tax_total_fils)::numeric * _coupon.discount_value / 100
      )::bigint;
    ELSE
      _coupon_discount_fils := public.bhd_to_fils(_coupon.discount_value);
    END IF;
    _coupon_discount_fils := LEAST(
      GREATEST(COALESCE(_coupon_discount_fils, 0), 0),
      _subtotal_fils + _tax_total_fils
    );

    UPDATE public.discount_codes SET current_uses = current_uses + 1 WHERE id = _coupon.id;
  ELSE
    _coupon_discount_fils := public.bhd_to_fils(COALESCE(_discount_total, 0));
    IF _coupon_discount_fils > 0 AND NOT public.has_branch_role(
      _user_id, _tenant_id, _branch_id, ARRAY['owner','admin','manager']::public.app_role[]
    ) THEN
      RAISE EXCEPTION 'Manager authorization is required for order discounts';
    END IF;
    _coupon_discount_fils := LEAST(_coupon_discount_fils, _subtotal_fils + _tax_total_fils);
  END IF;

  _total_fils := _subtotal_fils + _tax_total_fils - _coupon_discount_fils + _tip_fils;
  IF _total_fils < 0 THEN
    RAISE EXCEPTION 'Sale total cannot be negative';
  END IF;

  FOR _pay IN SELECT * FROM jsonb_array_elements(_payments) LOOP
    IF COALESCE((_pay->>'amount')::numeric, 0) <= 0 THEN
      RAISE EXCEPTION 'Every payment allocation must be greater than zero';
    END IF;
    IF COALESCE(_pay->>'method', '') NOT IN ('cash','card','transfer','qr') THEN
      RAISE EXCEPTION 'Unsupported payment method: %', COALESCE(_pay->>'method', '');
    END IF;
    _payment_total_fils := _payment_total_fils + public.bhd_to_fils((_pay->>'amount')::numeric);
  END LOOP;

  IF (_channel IN ('pos','tables') OR jsonb_array_length(_payments) > 0)
     AND _payment_total_fils <> _total_fils THEN
    RAISE EXCEPTION 'Payments (% fils) must exactly equal sale total (% fils)', _payment_total_fils, _total_fils;
  END IF;

  UPDATE public.sales
  SET subtotal = public.fils_to_bhd(_subtotal_fils),
      tax_total = public.fils_to_bhd(_tax_total_fils),
      discount_total = public.fils_to_bhd(_coupon_discount_fils),
      total = public.fils_to_bhd(_total_fils),
      tip_amount = public.fils_to_bhd(_tip_fils)
  WHERE id = _sale_id;

  FOR _pay IN SELECT * FROM jsonb_array_elements(_payments) LOOP
    INSERT INTO public.payments (tenant_id, sale_id, method, amount, reference)
    VALUES (
      _tenant_id,
      _sale_id,
      (_pay->>'method')::public.payment_method,
      public.fils_to_bhd(public.bhd_to_fils((_pay->>'amount')::numeric)),
      NULLIF(trim(COALESCE(_pay->>'reference', '')), '')
    );

    IF _session_id IS NOT NULL THEN
      UPDATE public.cash_sessions SET
        total_cash = total_cash + CASE WHEN _pay->>'method' = 'cash' THEN public.fils_to_bhd(public.bhd_to_fils((_pay->>'amount')::numeric)) ELSE 0 END,
        total_card = total_card + CASE WHEN _pay->>'method' = 'card' THEN public.fils_to_bhd(public.bhd_to_fils((_pay->>'amount')::numeric)) ELSE 0 END,
        total_transfer = total_transfer + CASE WHEN _pay->>'method' = 'transfer' THEN public.fils_to_bhd(public.bhd_to_fils((_pay->>'amount')::numeric)) ELSE 0 END,
        total_qr = total_qr + CASE WHEN _pay->>'method' = 'qr' THEN public.fils_to_bhd(public.bhd_to_fils((_pay->>'amount')::numeric)) ELSE 0 END
      WHERE id = _session_id;
    END IF;
  END LOOP;

  -- Preserve the existing loyalty policy until the dedicated loyalty-ledger phase.
  IF _customer_id IS NOT NULL THEN
    SELECT points_per_thousand INTO _points_config FROM public.tenants WHERE id = _tenant_id;
    _points_earned := floor(public.fils_to_bhd(_total_fils) / 1000) * COALESCE(_points_config, 0);
    IF _points_earned > 0 THEN
      UPDATE public.customers
      SET loyalty_points = loyalty_points + _points_earned
      WHERE id = _customer_id AND tenant_id = _tenant_id;
    END IF;
  END IF;

  INSERT INTO public.operation_log (
    tenant_id, branch_id, operation_type, client_mutation_id, entity_type, entity_id, payload
  ) VALUES (
    _tenant_id, _branch_id, 'checkout_sale', trim(_client_mutation_id), 'sales', _sale_id,
    jsonb_build_object(
      'channel', _channel,
      'total_fils', _total_fils,
      'payment_total_fils', _payment_total_fils,
      'cash_session_id', _session_id
    )
  ) ON CONFLICT (tenant_id, client_mutation_id) DO UPDATE
    SET entity_type = EXCLUDED.entity_type,
        entity_id = EXCLUDED.entity_id,
        payload = EXCLUDED.payload,
        status = 'success';

  UPDATE public.checkout_operations
  SET status = 'completed', sale_id = _sale_id, completed_at = now()
  WHERE id = _operation_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity, entity_id, metadata)
  VALUES (
    _tenant_id, _user_id, 'sale.checkout_committed', 'sales', _sale_id,
    jsonb_build_object(
      'branch_id', _branch_id,
      'channel', _channel,
      'total_fils', _total_fils,
      'payments', jsonb_array_length(_payments),
      'client_mutation_id', trim(_client_mutation_id),
      'cash_session_id', _session_id
    )
  );

  RETURN _sale_id;
END;
$$;

-- Preserve table-order checkout while routing it through the hardened checkout RPC.
DROP FUNCTION IF EXISTS public.checkout_table_order(uuid, jsonb, numeric, numeric, text, text);

CREATE OR REPLACE FUNCTION public.checkout_table_order(
  _order_id uuid,
  _payments jsonb,
  _tip_amount numeric DEFAULT 0,
  _discount_total numeric DEFAULT 0,
  _coupon_code text DEFAULT NULL,
  _client_mutation_id text DEFAULT NULL,
  _cash_session_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _o public.table_orders;
  _user_id uuid := auth.uid();
  _sale_id uuid;
  _items jsonb;
  _dev_mode boolean;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO _o FROM public.table_orders WHERE id = _order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF NOT public.has_branch_role(_user_id, _o.tenant_id, _o.branch_id, ARRAY['owner','admin','manager','cashier','waiter']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF _o.status NOT IN ('open','sent_to_cashier') THEN RAISE EXCEPTION 'Order not payable'; END IF;

  SELECT COALESCE(dev_mode, false) INTO _dev_mode FROM public.tenants WHERE id = _o.tenant_id;
  IF _dev_mode THEN
    UPDATE public.table_order_items SET status = 'dispatched'
    WHERE order_id = _order_id AND status IN ('pending','preparing','ready');
  ELSE
    UPDATE public.table_order_items SET status = 'cancelled'
    WHERE order_id = _order_id AND status = 'pending';
  END IF;

  PERFORM public.recalc_table_order(_order_id);

  SELECT jsonb_agg(jsonb_build_object(
    'product_id', product_id,
    'quantity', quantity,
    'discount', discount,
    'modifiers', modifiers
  ))
  INTO _items
  FROM public.table_order_items
  WHERE order_id = _order_id AND status = 'dispatched';

  IF _items IS NULL OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Table has no dispatched items to charge';
  END IF;

  _sale_id := public.checkout_sale(
    _o.tenant_id,
    _o.branch_id,
    _items,
    _payments,
    _discount_total,
    COALESCE(_o.notes, '') || ' [Table]',
    NULL,
    'tables'::public.sales_channel,
    _tip_amount,
    _coupon_code,
    COALESCE(_client_mutation_id, 'table:' || _order_id::text),
    _cash_session_id
  );

  UPDATE public.table_orders
  SET status = 'closed', closed_at = now(), sale_id = _sale_id
  WHERE id = _order_id;

  UPDATE public.tables SET status = 'available' WHERE id = _o.table_id;
  RETURN _sale_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.checkout_sale(
  uuid, uuid, jsonb, jsonb, numeric, text, uuid, public.sales_channel, numeric, text, text, uuid
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.checkout_table_order(
  uuid, jsonb, numeric, numeric, text, text, uuid
) TO authenticated;
