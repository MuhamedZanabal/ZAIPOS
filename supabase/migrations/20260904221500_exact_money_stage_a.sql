-- Exact BHD money migration, Stage A.
--
-- The existing NUMERIC columns remain authoritative during this compatibility
-- stage. Integer-fils sidecars are backfilled and synchronized from every
-- legacy write. A later migration will cut commands and reads over to fils.

BEGIN;

CREATE OR REPLACE FUNCTION public.bhd_numeric_to_fils(_amount numeric)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT round(_amount * 1000)::bigint;
$$;

CREATE OR REPLACE FUNCTION public.fils_to_bhd_numeric(_amount_fils bigint)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT _amount_fils::numeric / 1000;
$$;

CREATE OR REPLACE FUNCTION public.sync_fils_columns_from_numeric()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  _mapping jsonb := TG_ARGV[0]::jsonb;
  _new_row jsonb := to_jsonb(NEW);
  _old_row jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  _pair record;
  _legacy_amount text;
BEGIN
  FOR _pair IN SELECT key AS legacy_column, value AS fils_column FROM jsonb_each_text(_mapping)
  LOOP
    IF TG_OP = 'INSERT'
       OR (_new_row -> _pair.legacy_column) IS DISTINCT FROM (_old_row -> _pair.legacy_column)
       OR (_new_row -> _pair.fils_column) = 'null'::jsonb
    THEN
      _legacy_amount := _new_row ->> _pair.legacy_column;
      _new_row := jsonb_set(
        _new_row,
        ARRAY[_pair.fils_column],
        CASE
          WHEN _legacy_amount IS NULL THEN 'null'::jsonb
          ELSE to_jsonb(public.bhd_numeric_to_fils(_legacy_amount::numeric))
        END
      );
    END IF;
  END LOOP;

  NEW := jsonb_populate_record(NEW, _new_row);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_fils_columns_from_numeric() FROM PUBLIC;

ALTER TABLE public.products
  ADD COLUMN price_fils bigint,
  ADD COLUMN cost_fils bigint;

ALTER TABLE public.branch_products
  ADD COLUMN local_price_fils bigint;

ALTER TABLE public.product_channel_prices
  ADD COLUMN price_fils bigint;

ALTER TABLE public.sales
  ADD COLUMN subtotal_fils bigint,
  ADD COLUMN tax_total_fils bigint,
  ADD COLUMN discount_total_fils bigint,
  ADD COLUMN tip_amount_fils bigint,
  ADD COLUMN total_fils bigint;

ALTER TABLE public.sale_items
  ADD COLUMN unit_price_fils bigint,
  ADD COLUMN discount_fils bigint,
  ADD COLUMN line_total_fils bigint;

ALTER TABLE public.payments
  ADD COLUMN amount_fils bigint;

ALTER TABLE public.cash_sessions
  ADD COLUMN opening_amount_fils bigint,
  ADD COLUMN closing_amount_fils bigint,
  ADD COLUMN expected_amount_fils bigint,
  ADD COLUMN difference_fils bigint,
  ADD COLUMN total_cash_fils bigint,
  ADD COLUMN total_card_fils bigint,
  ADD COLUMN total_transfer_fils bigint,
  ADD COLUMN total_qr_fils bigint,
  ADD COLUMN total_in_fils bigint,
  ADD COLUMN total_out_fils bigint,
  ADD COLUMN counted_cash_fils bigint,
  ADD COLUMN counted_card_fils bigint,
  ADD COLUMN counted_transfer_fils bigint,
  ADD COLUMN counted_qr_fils bigint;

ALTER TABLE public.cash_movements
  ADD COLUMN amount_fils bigint;

UPDATE public.products
SET price_fils = public.bhd_numeric_to_fils(price),
    cost_fils = public.bhd_numeric_to_fils(cost);

UPDATE public.branch_products
SET local_price_fils = public.bhd_numeric_to_fils(local_price)
WHERE local_price IS NOT NULL;

UPDATE public.product_channel_prices
SET price_fils = public.bhd_numeric_to_fils(price);

UPDATE public.sales
SET subtotal_fils = public.bhd_numeric_to_fils(subtotal),
    tax_total_fils = public.bhd_numeric_to_fils(tax_total),
    discount_total_fils = public.bhd_numeric_to_fils(discount_total),
    tip_amount_fils = public.bhd_numeric_to_fils(tip_amount),
    total_fils = public.bhd_numeric_to_fils(total);

UPDATE public.sale_items
SET unit_price_fils = public.bhd_numeric_to_fils(unit_price),
    discount_fils = public.bhd_numeric_to_fils(discount),
    line_total_fils = public.bhd_numeric_to_fils(line_total);

UPDATE public.payments
SET amount_fils = public.bhd_numeric_to_fils(amount);

UPDATE public.cash_sessions
SET opening_amount_fils = public.bhd_numeric_to_fils(opening_amount),
    closing_amount_fils = public.bhd_numeric_to_fils(closing_amount),
    expected_amount_fils = public.bhd_numeric_to_fils(expected_amount),
    difference_fils = public.bhd_numeric_to_fils(difference),
    total_cash_fils = public.bhd_numeric_to_fils(total_cash),
    total_card_fils = public.bhd_numeric_to_fils(total_card),
    total_transfer_fils = public.bhd_numeric_to_fils(total_transfer),
    total_qr_fils = public.bhd_numeric_to_fils(total_qr),
    total_in_fils = public.bhd_numeric_to_fils(total_in),
    total_out_fils = public.bhd_numeric_to_fils(total_out),
    counted_cash_fils = public.bhd_numeric_to_fils(counted_cash),
    counted_card_fils = public.bhd_numeric_to_fils(counted_card),
    counted_transfer_fils = public.bhd_numeric_to_fils(counted_transfer),
    counted_qr_fils = public.bhd_numeric_to_fils(counted_qr);

UPDATE public.cash_movements
SET amount_fils = public.bhd_numeric_to_fils(amount);

ALTER TABLE public.products
  ALTER COLUMN price_fils SET NOT NULL,
  ALTER COLUMN cost_fils SET NOT NULL;

ALTER TABLE public.product_channel_prices
  ALTER COLUMN price_fils SET NOT NULL;

ALTER TABLE public.sales
  ALTER COLUMN subtotal_fils SET NOT NULL,
  ALTER COLUMN tax_total_fils SET NOT NULL,
  ALTER COLUMN discount_total_fils SET NOT NULL,
  ALTER COLUMN tip_amount_fils SET NOT NULL,
  ALTER COLUMN total_fils SET NOT NULL;

ALTER TABLE public.sale_items
  ALTER COLUMN unit_price_fils SET NOT NULL,
  ALTER COLUMN discount_fils SET NOT NULL,
  ALTER COLUMN line_total_fils SET NOT NULL;

ALTER TABLE public.payments
  ALTER COLUMN amount_fils SET NOT NULL;

ALTER TABLE public.cash_sessions
  ALTER COLUMN opening_amount_fils SET NOT NULL,
  ALTER COLUMN total_cash_fils SET NOT NULL,
  ALTER COLUMN total_card_fils SET NOT NULL,
  ALTER COLUMN total_transfer_fils SET NOT NULL,
  ALTER COLUMN total_qr_fils SET NOT NULL,
  ALTER COLUMN total_in_fils SET NOT NULL,
  ALTER COLUMN total_out_fils SET NOT NULL;

ALTER TABLE public.cash_movements
  ALTER COLUMN amount_fils SET NOT NULL;

CREATE TRIGGER sync_products_fils
BEFORE INSERT OR UPDATE ON public.products
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"price":"price_fils","cost":"cost_fils"}'
);

CREATE TRIGGER sync_branch_products_fils
BEFORE INSERT OR UPDATE ON public.branch_products
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"local_price":"local_price_fils"}'
);

CREATE TRIGGER sync_product_channel_prices_fils
BEFORE INSERT OR UPDATE ON public.product_channel_prices
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"price":"price_fils"}'
);

CREATE TRIGGER sync_sales_fils
BEFORE INSERT OR UPDATE ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"subtotal":"subtotal_fils","tax_total":"tax_total_fils","discount_total":"discount_total_fils","tip_amount":"tip_amount_fils","total":"total_fils"}'
);

CREATE TRIGGER sync_sale_items_fils
BEFORE INSERT OR UPDATE ON public.sale_items
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"unit_price":"unit_price_fils","discount":"discount_fils","line_total":"line_total_fils"}'
);

CREATE TRIGGER sync_payments_fils
BEFORE INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"amount":"amount_fils"}'
);

CREATE TRIGGER sync_cash_sessions_fils
BEFORE INSERT OR UPDATE ON public.cash_sessions
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"opening_amount":"opening_amount_fils","closing_amount":"closing_amount_fils","expected_amount":"expected_amount_fils","difference":"difference_fils","total_cash":"total_cash_fils","total_card":"total_card_fils","total_transfer":"total_transfer_fils","total_qr":"total_qr_fils","total_in":"total_in_fils","total_out":"total_out_fils","counted_cash":"counted_cash_fils","counted_card":"counted_card_fils","counted_transfer":"counted_transfer_fils","counted_qr":"counted_qr_fils"}'
);

CREATE TRIGGER sync_cash_movements_fils
BEFORE INSERT OR UPDATE ON public.cash_movements
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"amount":"amount_fils"}'
);

ALTER TABLE public.products
  ADD CONSTRAINT products_money_fils_parity CHECK (
    price_fils = public.bhd_numeric_to_fils(price)
    AND cost_fils = public.bhd_numeric_to_fils(cost)
  );

ALTER TABLE public.branch_products
  ADD CONSTRAINT branch_products_money_fils_parity CHECK (
    local_price_fils IS NOT DISTINCT FROM public.bhd_numeric_to_fils(local_price)
  );

ALTER TABLE public.product_channel_prices
  ADD CONSTRAINT product_channel_prices_money_fils_parity CHECK (
    price_fils = public.bhd_numeric_to_fils(price)
  );

ALTER TABLE public.sales
  ADD CONSTRAINT sales_money_fils_parity CHECK (
    subtotal_fils = public.bhd_numeric_to_fils(subtotal)
    AND tax_total_fils = public.bhd_numeric_to_fils(tax_total)
    AND discount_total_fils = public.bhd_numeric_to_fils(discount_total)
    AND tip_amount_fils = public.bhd_numeric_to_fils(tip_amount)
    AND total_fils = public.bhd_numeric_to_fils(total)
  );

ALTER TABLE public.sale_items
  ADD CONSTRAINT sale_items_money_fils_parity CHECK (
    unit_price_fils = public.bhd_numeric_to_fils(unit_price)
    AND discount_fils = public.bhd_numeric_to_fils(discount)
    AND line_total_fils = public.bhd_numeric_to_fils(line_total)
  );

ALTER TABLE public.payments
  ADD CONSTRAINT payments_money_fils_parity CHECK (
    amount_fils = public.bhd_numeric_to_fils(amount)
  );

ALTER TABLE public.cash_sessions
  ADD CONSTRAINT cash_sessions_money_fils_parity CHECK (
    opening_amount_fils = public.bhd_numeric_to_fils(opening_amount)
    AND closing_amount_fils IS NOT DISTINCT FROM public.bhd_numeric_to_fils(closing_amount)
    AND expected_amount_fils IS NOT DISTINCT FROM public.bhd_numeric_to_fils(expected_amount)
    AND difference_fils IS NOT DISTINCT FROM public.bhd_numeric_to_fils(difference)
    AND total_cash_fils = public.bhd_numeric_to_fils(total_cash)
    AND total_card_fils = public.bhd_numeric_to_fils(total_card)
    AND total_transfer_fils = public.bhd_numeric_to_fils(total_transfer)
    AND total_qr_fils = public.bhd_numeric_to_fils(total_qr)
    AND total_in_fils = public.bhd_numeric_to_fils(total_in)
    AND total_out_fils = public.bhd_numeric_to_fils(total_out)
    AND counted_cash_fils IS NOT DISTINCT FROM public.bhd_numeric_to_fils(counted_cash)
    AND counted_card_fils IS NOT DISTINCT FROM public.bhd_numeric_to_fils(counted_card)
    AND counted_transfer_fils IS NOT DISTINCT FROM public.bhd_numeric_to_fils(counted_transfer)
    AND counted_qr_fils IS NOT DISTINCT FROM public.bhd_numeric_to_fils(counted_qr)
  );

ALTER TABLE public.cash_movements
  ADD CONSTRAINT cash_movements_money_fils_parity CHECK (
    amount_fils = public.bhd_numeric_to_fils(amount)
  );

CREATE VIEW public.money_fils_parity_violations
WITH (security_invoker = true)
AS
SELECT p.tenant_id, 'products'::text AS table_name, p.id AS row_id,
       v.column_name, v.legacy_amount, v.stored_fils, v.expected_fils
FROM public.products p
CROSS JOIN LATERAL (VALUES
  ('price'::text, p.price, p.price_fils, public.bhd_numeric_to_fils(p.price)),
  ('cost'::text, p.cost, p.cost_fils, public.bhd_numeric_to_fils(p.cost))
) AS v(column_name, legacy_amount, stored_fils, expected_fils)
WHERE v.stored_fils IS DISTINCT FROM v.expected_fils
UNION ALL
SELECT p.tenant_id, 'branch_products', p.id, 'local_price', p.local_price,
       p.local_price_fils, public.bhd_numeric_to_fils(p.local_price)
FROM public.branch_products p
WHERE p.local_price_fils IS DISTINCT FROM public.bhd_numeric_to_fils(p.local_price)
UNION ALL
SELECT p.tenant_id, 'product_channel_prices', p.id, 'price', p.price,
       p.price_fils, public.bhd_numeric_to_fils(p.price)
FROM public.product_channel_prices p
WHERE p.price_fils IS DISTINCT FROM public.bhd_numeric_to_fils(p.price)
UNION ALL
SELECT s.tenant_id, 'sales', s.id, v.column_name, v.legacy_amount, v.stored_fils, v.expected_fils
FROM public.sales s
CROSS JOIN LATERAL (VALUES
  ('subtotal'::text, s.subtotal, s.subtotal_fils, public.bhd_numeric_to_fils(s.subtotal)),
  ('tax_total'::text, s.tax_total, s.tax_total_fils, public.bhd_numeric_to_fils(s.tax_total)),
  ('discount_total'::text, s.discount_total, s.discount_total_fils, public.bhd_numeric_to_fils(s.discount_total)),
  ('tip_amount'::text, s.tip_amount, s.tip_amount_fils, public.bhd_numeric_to_fils(s.tip_amount)),
  ('total'::text, s.total, s.total_fils, public.bhd_numeric_to_fils(s.total))
) AS v(column_name, legacy_amount, stored_fils, expected_fils)
WHERE v.stored_fils IS DISTINCT FROM v.expected_fils
UNION ALL
SELECT i.tenant_id, 'sale_items', i.id, v.column_name, v.legacy_amount, v.stored_fils, v.expected_fils
FROM public.sale_items i
CROSS JOIN LATERAL (VALUES
  ('unit_price'::text, i.unit_price, i.unit_price_fils, public.bhd_numeric_to_fils(i.unit_price)),
  ('discount'::text, i.discount, i.discount_fils, public.bhd_numeric_to_fils(i.discount)),
  ('line_total'::text, i.line_total, i.line_total_fils, public.bhd_numeric_to_fils(i.line_total))
) AS v(column_name, legacy_amount, stored_fils, expected_fils)
WHERE v.stored_fils IS DISTINCT FROM v.expected_fils
UNION ALL
SELECT p.tenant_id, 'payments', p.id, 'amount', p.amount,
       p.amount_fils, public.bhd_numeric_to_fils(p.amount)
FROM public.payments p
WHERE p.amount_fils IS DISTINCT FROM public.bhd_numeric_to_fils(p.amount)
UNION ALL
SELECT s.tenant_id, 'cash_sessions', s.id, v.column_name, v.legacy_amount, v.stored_fils, v.expected_fils
FROM public.cash_sessions s
CROSS JOIN LATERAL (VALUES
  ('opening_amount'::text, s.opening_amount, s.opening_amount_fils, public.bhd_numeric_to_fils(s.opening_amount)),
  ('closing_amount'::text, s.closing_amount, s.closing_amount_fils, public.bhd_numeric_to_fils(s.closing_amount)),
  ('expected_amount'::text, s.expected_amount, s.expected_amount_fils, public.bhd_numeric_to_fils(s.expected_amount)),
  ('difference'::text, s.difference, s.difference_fils, public.bhd_numeric_to_fils(s.difference)),
  ('total_cash'::text, s.total_cash, s.total_cash_fils, public.bhd_numeric_to_fils(s.total_cash)),
  ('total_card'::text, s.total_card, s.total_card_fils, public.bhd_numeric_to_fils(s.total_card)),
  ('total_transfer'::text, s.total_transfer, s.total_transfer_fils, public.bhd_numeric_to_fils(s.total_transfer)),
  ('total_qr'::text, s.total_qr, s.total_qr_fils, public.bhd_numeric_to_fils(s.total_qr)),
  ('total_in'::text, s.total_in, s.total_in_fils, public.bhd_numeric_to_fils(s.total_in)),
  ('total_out'::text, s.total_out, s.total_out_fils, public.bhd_numeric_to_fils(s.total_out)),
  ('counted_cash'::text, s.counted_cash, s.counted_cash_fils, public.bhd_numeric_to_fils(s.counted_cash)),
  ('counted_card'::text, s.counted_card, s.counted_card_fils, public.bhd_numeric_to_fils(s.counted_card)),
  ('counted_transfer'::text, s.counted_transfer, s.counted_transfer_fils, public.bhd_numeric_to_fils(s.counted_transfer)),
  ('counted_qr'::text, s.counted_qr, s.counted_qr_fils, public.bhd_numeric_to_fils(s.counted_qr))
) AS v(column_name, legacy_amount, stored_fils, expected_fils)
WHERE v.stored_fils IS DISTINCT FROM v.expected_fils
UNION ALL
SELECT m.tenant_id, 'cash_movements', m.id, 'amount', m.amount,
       m.amount_fils, public.bhd_numeric_to_fils(m.amount)
FROM public.cash_movements m
WHERE m.amount_fils IS DISTINCT FROM public.bhd_numeric_to_fils(m.amount);

REVOKE ALL ON public.money_fils_parity_violations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.money_fils_parity_violations TO service_role;

COMMENT ON VIEW public.money_fils_parity_violations IS
  'Stage A diagnostic. Must return zero rows before integer-fils cutover.';

COMMIT;
