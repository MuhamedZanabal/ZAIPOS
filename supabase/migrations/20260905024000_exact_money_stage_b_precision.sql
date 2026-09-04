-- ZAIPOS exact BHD money migration, Stage B.
--
-- Stage A introduced BIGINT fils sidecars but deliberately kept the inherited
-- NUMERIC compatibility columns authoritative. Several of those columns were
-- originally NUMERIC(12,2), which rounds valid Bahrain amounts such as 1.025
-- before the Stage A trigger can derive the corresponding fils value.
--
-- This forward migration widens monetary compatibility columns to NUMERIC(18,3).
-- Widening 2-decimal values to 3 decimals is lossless for existing rows and lets
-- subsequent server-authoritative commands preserve every fils exactly while the
-- legacy column names remain available during the staged cutover.

BEGIN;

-- PostgreSQL will not alter a column type while a view depends on that column.
-- Stage A's parity diagnostic is recreated, with the same restricted access,
-- after the lossless widening completes.
DROP VIEW IF EXISTS public.money_fils_parity_violations;

DO $$
DECLARE
  _entry record;
BEGIN
  FOR _entry IN
    SELECT *
    FROM (VALUES
      ('products', 'price'),
      ('products', 'cost'),
      ('branch_products', 'local_price'),
      ('product_channel_prices', 'price'),
      ('modifier_options', 'price_delta'),
      ('discount_codes', 'discount_value'),
      ('sales', 'subtotal'),
      ('sales', 'tax_total'),
      ('sales', 'discount_total'),
      ('sales', 'tip_amount'),
      ('sales', 'total'),
      ('sale_items', 'unit_price'),
      ('sale_items', 'discount'),
      ('sale_items', 'line_total'),
      ('payments', 'amount'),
      ('cash_sessions', 'opening_amount'),
      ('cash_sessions', 'closing_amount'),
      ('cash_sessions', 'expected_amount'),
      ('cash_sessions', 'difference'),
      ('cash_sessions', 'total_cash'),
      ('cash_sessions', 'total_card'),
      ('cash_sessions', 'total_transfer'),
      ('cash_sessions', 'total_qr'),
      ('cash_sessions', 'total_in'),
      ('cash_sessions', 'total_out'),
      ('cash_sessions', 'counted_cash'),
      ('cash_sessions', 'counted_card'),
      ('cash_sessions', 'counted_transfer'),
      ('cash_sessions', 'counted_qr'),
      ('cash_movements', 'amount'),
      ('table_orders', 'subtotal'),
      ('table_orders', 'tax_total'),
      ('table_orders', 'discount_total'),
      ('table_orders', 'total'),
      ('table_order_items', 'unit_price'),
      ('table_order_items', 'discount'),
      ('table_order_items', 'line_total'),
      ('digital_orders', 'gross_total'),
      ('digital_orders', 'platform_commission'),
      ('digital_orders', 'net_total'),
      ('digital_order_items', 'unit_price'),
      ('digital_order_items', 'discount'),
      ('digital_order_items', 'line_total'),
      ('purchase_orders', 'total'),
      ('purchase_order_items', 'cost_price'),
      ('purchase_order_items', 'line_total'),
      ('expenses', 'amount'),
      ('sale_returns', 'amount')
    ) AS money_columns(table_name, column_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = _entry.table_name
        AND column_name = _entry.column_name
        AND data_type = 'numeric'
        AND (numeric_scale IS NULL OR numeric_scale < 3 OR numeric_precision IS NULL OR numeric_precision < 18)
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I TYPE numeric(18,3) USING %I::numeric(18,3)',
        _entry.table_name,
        _entry.column_name,
        _entry.column_name
      );
    END IF;
  END LOOP;
END;
$$;

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
  'Stage A/B diagnostic. Must return zero rows before integer-fils authoritative cutover.';

COMMIT;
