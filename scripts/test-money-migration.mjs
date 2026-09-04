import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrationPath = new URL(
  "../supabase/migrations/20260904221500_exact_money_stage_a.sql",
  import.meta.url,
);
const migration = await readFile(migrationPath, "utf8");
const db = new PGlite();

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;

    -- Mirror the production baseline: inherited monetary columns are NUMERIC(12,2).
    -- Stage B must widen these compatibility columns before new 3-decimal BHD writes.
    CREATE TABLE public.products (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
      price numeric(12,2) NOT NULL, cost numeric(12,2) NOT NULL
    );
    CREATE TABLE public.branch_products (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, local_price numeric(12,2)
    );
    CREATE TABLE public.product_channel_prices (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, price numeric(12,2) NOT NULL
    );
    CREATE TABLE public.sales (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
      subtotal numeric(12,2) NOT NULL, tax_total numeric(12,2) NOT NULL,
      discount_total numeric(12,2) NOT NULL, tip_amount numeric(12,2) NOT NULL,
      total numeric(12,2) NOT NULL
    );
    CREATE TABLE public.sale_items (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
      unit_price numeric(12,2) NOT NULL, discount numeric(12,2) NOT NULL,
      line_total numeric(12,2) NOT NULL
    );
    CREATE TABLE public.payments (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, amount numeric(12,2) NOT NULL
    );
    CREATE TABLE public.cash_sessions (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
      opening_amount numeric(12,2) NOT NULL, closing_amount numeric(12,2),
      expected_amount numeric(12,2), difference numeric(12,2),
      total_cash numeric(12,2) NOT NULL, total_card numeric(12,2) NOT NULL,
      total_transfer numeric(12,2) NOT NULL, total_qr numeric(12,2) NOT NULL,
      total_in numeric(12,2) NOT NULL, total_out numeric(12,2) NOT NULL,
      counted_cash numeric(12,2), counted_card numeric(12,2),
      counted_transfer numeric(12,2), counted_qr numeric(12,2)
    );
    CREATE TABLE public.cash_movements (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, amount numeric(12,2) NOT NULL
    );

    INSERT INTO public.products VALUES
      ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 12.65, 0.02);
    INSERT INTO public.branch_products VALUES
      ('00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', NULL);
    INSERT INTO public.product_channel_prices VALUES
      ('00000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 1.27);
    INSERT INTO public.sales VALUES
      ('00000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 10, 1, 0.25, 0.50, 11.25);
    INSERT INTO public.sale_items VALUES
      ('00000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 10, 0.25, 10.75);
    INSERT INTO public.payments VALUES
      ('00000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 11.25);
    INSERT INTO public.cash_sessions VALUES
      ('00000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001',
       10, NULL, NULL, NULL, 5, 3.50, 0, 2.75, 1, 0.50, NULL, NULL, NULL, NULL);
    INSERT INTO public.cash_movements VALUES
      ('00000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', 0.02);
  `);

  await db.exec(migration);

  const product = await db.query(`
    SELECT price_fils, cost_fils FROM public.products
    WHERE id = '00000000-0000-0000-0000-000000000001'
  `);
  if (product.rows[0].price_fils !== 12_650 || product.rows[0].cost_fils !== 20) {
    throw new Error(`Unexpected product backfill: ${JSON.stringify(product.rows[0])}`);
  }

  const cash = await db.query(`
    SELECT opening_amount_fils, closing_amount_fils, total_qr_fils
    FROM public.cash_sessions
    WHERE id = '00000000-0000-0000-0000-000000000007'
  `);
  if (
    cash.rows[0].opening_amount_fils !== 10_000
    || cash.rows[0].closing_amount_fils !== null
    || cash.rows[0].total_qr_fils !== 2_750
  ) {
    throw new Error(`Unexpected cash backfill: ${JSON.stringify(cash.rows[0])}`);
  }

  // This is the production-critical red assertion: NUMERIC(12,2) cannot preserve
  // a three-decimal BHD write, so Stage B must widen the compatibility columns.
  await db.exec(`
    UPDATE public.products SET price = 1.234
    WHERE id = '00000000-0000-0000-0000-000000000001'
  `);
  const synced = await db.query(`
    SELECT price, price_fils FROM public.products
    WHERE id = '00000000-0000-0000-0000-000000000001'
  `);
  if (synced.rows[0].price !== "1.234" || synced.rows[0].price_fils !== 1_234) {
    throw new Error(`Three-decimal BHD write was not preserved: ${JSON.stringify(synced.rows[0])}`);
  }

  let parityConstraintBlocked = false;
  try {
    await db.exec(`
      UPDATE public.products SET price_fils = 999
      WHERE id = '00000000-0000-0000-0000-000000000001'
    `);
  } catch {
    parityConstraintBlocked = true;
  }
  if (!parityConstraintBlocked) {
    throw new Error("Parity constraint allowed a mismatched fils value");
  }

  const violations = await db.query(
    "SELECT count(*)::int AS count FROM public.money_fils_parity_violations",
  );
  if (violations.rows[0].count !== 0) {
    throw new Error(`Parity diagnostics returned ${violations.rows[0].count} violation(s)`);
  }

  const privileges = await db.query(`
    SELECT
      has_function_privilege('anon', 'public.sync_fils_columns_from_numeric()', 'EXECUTE')
        AS anon_can_execute_trigger_helper,
      has_table_privilege('anon', 'public.money_fils_parity_violations', 'SELECT')
        AS anon_can_read_diagnostics,
      has_table_privilege('service_role', 'public.money_fils_parity_violations', 'SELECT')
        AS service_role_can_read_diagnostics
  `);
  if (
    privileges.rows[0].anon_can_execute_trigger_helper
    || privileges.rows[0].anon_can_read_diagnostics
    || !privileges.rows[0].service_role_can_read_diagnostics
  ) {
    throw new Error(`Unexpected money migration privileges: ${JSON.stringify(privileges.rows[0])}`);
  }

  console.log("PASS: money migrations preserve exact three-decimal BHD writes and fils parity.");
} finally {
  await db.close();
}
