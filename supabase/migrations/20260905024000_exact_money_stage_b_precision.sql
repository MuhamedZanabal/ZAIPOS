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

COMMIT;
