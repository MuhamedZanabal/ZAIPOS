import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const paths = [
  new URL("../supabase/migrations/20260904221500_exact_money_stage_a.sql", import.meta.url),
  new URL("../supabase/migrations/20260905024000_exact_money_stage_b_precision.sql", import.meta.url),
  new URL("../supabase/migrations/20260905032000_atomic_checkout_v2.sql", import.meta.url),
  new URL("../supabase/migrations/20260905033000_checkout_sale_v2_compat.sql", import.meta.url),
];

const [stageA, stageB, checkoutV2, checkoutCompat] = await Promise.all(paths.map((path) => readFile(path, "utf8")));
const db = new PGlite();

const IDS = {
  tenantA: "10000000-0000-0000-0000-000000000001",
  tenantB: "10000000-0000-0000-0000-000000000002",
  branchA: "20000000-0000-0000-0000-000000000001",
  branchB: "20000000-0000-0000-0000-000000000002",
  cashier: "30000000-0000-0000-0000-000000000001",
  outsider: "30000000-0000-0000-0000-000000000002",
  sessionA: "40000000-0000-0000-0000-000000000001",
  closedSession: "40000000-0000-0000-0000-000000000002",
  productA: "50000000-0000-0000-0000-000000000001",
  customerA: "60000000-0000-0000-0000-000000000001",
  customerB: "60000000-0000-0000-0000-000000000002",
};

async function expectReject(label, sql, expectedMessage) {
  let rejected = false;
  try {
    await db.query(sql);
  } catch (error) {
    rejected = true;
    const message = String(error?.message ?? error);
    if (!message.includes(expectedMessage)) {
      throw new Error(`${label}: expected error containing ${JSON.stringify(expectedMessage)}, got ${message}`);
    }
  }
  if (!rejected) throw new Error(`${label}: expected checkout to be rejected`);
}

async function expectNoCheckoutEffects(operationId) {
  const result = await db.query(`
    SELECT
      (SELECT count(*)::int FROM public.sales
       WHERE client_mutation_id = '${operationId}') AS sales,
      (SELECT count(*)::int FROM public.checkout_operations
       WHERE client_mutation_id = '${operationId}') AS operations
  `);
  if (result.rows[0].sales !== 0 || result.rows[0].operations !== 0) {
    throw new Error(`Rejected checkout ${operationId} left partial effects: ${JSON.stringify(result.rows[0])}`);
  }
}

function checkoutSql({
  operationId,
  payments = [
    { method: "cash", amount_fils: 500 },
    { method: "card", amount_fils: 300 },
    { method: "qr", amount_fils: 250 },
    { method: "transfer", amount_fils: 78 },
  ],
  customerId = null,
  sessionId = IDS.sessionA,
  quantity = "1.000",
  itemExtra = {},
  discountFils = 0,
  tipFils = 0,
  couponCode = null,
} = {}) {
  const items = [{
    product_id: IDS.productA,
    quantity,
    discount_fils: 0,
    // Deliberately malicious/stale client values. The server must not trust them.
    unit_price_fils: 1,
    tax_rate: 0,
    ...itemExtra,
  }];
  return `SELECT public.checkout_sale_v2(
    '${IDS.tenantA}'::uuid,
    '${IDS.branchA}'::uuid,
    '${JSON.stringify(items)}'::jsonb,
    '${JSON.stringify(payments)}'::jsonb,
    ${discountFils}::bigint,
    NULL,
    ${customerId ? `'${customerId}'::uuid` : "NULL::uuid"},
    'pos'::public.sales_channel,
    ${tipFils}::bigint,
    ${couponCode ? `'${couponCode.replaceAll("'", "''")}'::text` : "NULL::text"},
    '${operationId}',
    ${sessionId ? `'${sessionId}'::uuid` : "NULL::uuid"}
  ) AS sale_id`;
}

function legacyCheckoutSql({ operationId, paymentAmount = "1.128" } = {}) {
  const items = [{
    product_id: IDS.productA,
    quantity: "1.000",
    // Current clients still send these fields. The adapter must discard them.
    unit_price: "999.999",
    tax_rate: "0.00",
    discount: "0.000",
    modifiers: [],
  }];
  const payments = [{ method: "cash", amount: paymentAmount, reference: null }];

  return `SELECT public.checkout_sale(
    '${IDS.tenantA}'::uuid,
    '${IDS.branchA}'::uuid,
    '${JSON.stringify(items)}'::jsonb,
    '${JSON.stringify(payments)}'::jsonb,
    0.000::numeric,
    NULL,
    NULL::uuid,
    'pos'::public.sales_channel,
    0.000::numeric,
    NULL,
    '${operationId}'
  ) AS sale_id`;
}

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;

    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE OR REPLACE FUNCTION auth.uid()
    RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    CREATE TYPE public.app_role AS ENUM (
      'super_admin','owner','admin','manager','cashier','kitchen','inventory','courier','staff','waiter'
    );
    CREATE TYPE public.product_type AS ENUM ('simple','composite','production','combo','ingredient','modifier');
    CREATE TYPE public.movement_type AS ENUM ('purchase','sale','production','waste','adjustment','transfer','return','consumption');
    CREATE TYPE public.payment_method AS ENUM ('cash','card','transfer','qr');
    CREATE TYPE public.sale_status AS ENUM ('completed','cancelled','refunded','partially_refunded');
    CREATE TYPE public.cash_session_status AS ENUM ('open','closed');
    CREATE TYPE public.entity_status AS ENUM ('active','inactive');
    CREATE TYPE public.sales_channel AS ENUM ('pos','delivery','tables','whatsapp','qr');

    CREATE TABLE public.tenants (
      id uuid PRIMARY KEY,
      dev_mode boolean NOT NULL DEFAULT false,
      allow_negative_stock boolean NOT NULL DEFAULT false,
      points_per_thousand integer NOT NULL DEFAULT 0
    );
    CREATE TABLE public.branches (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      status public.entity_status NOT NULL DEFAULT 'active'
    );
    CREATE TABLE public.user_roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES auth.users(id),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid REFERENCES public.branches(id),
      role public.app_role NOT NULL
    );

    CREATE OR REPLACE FUNCTION public.has_any_role(
      _user_id uuid, _tenant_id uuid, _roles public.app_role[]
    ) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = _user_id AND tenant_id = _tenant_id AND role = ANY(_roles)
      )
    $$;

    CREATE OR REPLACE FUNCTION public.has_branch_role(
      _user_id uuid, _tenant_id uuid, _branch_id uuid, _roles public.app_role[]
    ) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = _user_id
          AND tenant_id = _tenant_id
          AND role = ANY(_roles)
          AND (branch_id IS NULL OR branch_id = _branch_id)
      )
    $$;

    CREATE TABLE public.products (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      name text NOT NULL,
      product_type public.product_type NOT NULL DEFAULT 'simple',
      price numeric(12,2) NOT NULL DEFAULT 0,
      cost numeric(12,2) NOT NULL DEFAULT 0,
      tax_rate numeric(5,2) NOT NULL DEFAULT 0,
      status public.entity_status NOT NULL DEFAULT 'active'
    );
    CREATE TABLE public.branch_products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      local_price numeric(12,2),
      is_available boolean NOT NULL DEFAULT true,
      UNIQUE(branch_id, product_id)
    );
    CREATE TABLE public.product_channel_prices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid REFERENCES public.branches(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      channel public.sales_channel NOT NULL,
      price numeric(12,2) NOT NULL
    );
    CREATE TABLE public.product_components (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      parent_product_id uuid NOT NULL REFERENCES public.products(id),
      component_product_id uuid NOT NULL REFERENCES public.products(id),
      quantity numeric(12,3) NOT NULL,
      waste_pct numeric(5,2) DEFAULT 0
    );
    CREATE TABLE public.modifier_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      name text NOT NULL
    );
    CREATE TABLE public.modifier_options (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES public.modifier_groups(id),
      name text NOT NULL,
      price_delta numeric(12,2) NOT NULL DEFAULT 0,
      is_available boolean NOT NULL DEFAULT true
    );

    CREATE TABLE public.customers (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      name text NOT NULL,
      loyalty_points integer NOT NULL DEFAULT 0
    );
    CREATE TABLE public.cash_sessions (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      user_id uuid NOT NULL REFERENCES auth.users(id),
      opening_amount numeric(12,2) NOT NULL DEFAULT 0,
      closing_amount numeric(12,2),
      expected_amount numeric(12,2),
      difference numeric(12,2),
      total_cash numeric(12,2) NOT NULL DEFAULT 0,
      total_card numeric(12,2) NOT NULL DEFAULT 0,
      total_transfer numeric(12,2) NOT NULL DEFAULT 0,
      total_qr numeric(12,2) NOT NULL DEFAULT 0,
      total_in numeric(12,2) NOT NULL DEFAULT 0,
      total_out numeric(12,2) NOT NULL DEFAULT 0,
      counted_cash numeric(12,2),
      counted_card numeric(12,2),
      counted_transfer numeric(12,2),
      counted_qr numeric(12,2),
      status public.cash_session_status NOT NULL DEFAULT 'open',
      opened_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.cash_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      session_id uuid NOT NULL REFERENCES public.cash_sessions(id),
      amount numeric(12,2) NOT NULL
    );

    CREATE TABLE public.sales (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      session_id uuid REFERENCES public.cash_sessions(id),
      user_id uuid NOT NULL REFERENCES auth.users(id),
      customer_id uuid REFERENCES public.customers(id),
      subtotal numeric(12,2) NOT NULL DEFAULT 0,
      tax_total numeric(12,2) NOT NULL DEFAULT 0,
      discount_total numeric(12,2) NOT NULL DEFAULT 0,
      tip_amount numeric(12,2) NOT NULL DEFAULT 0,
      total numeric(12,2) NOT NULL DEFAULT 0,
      status public.sale_status NOT NULL DEFAULT 'completed',
      notes text,
      channel public.sales_channel NOT NULL DEFAULT 'pos',
      coupon_code text,
      client_mutation_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX sales_client_mutation_unique
      ON public.sales(tenant_id, client_mutation_id) WHERE client_mutation_id IS NOT NULL;

    CREATE TABLE public.sale_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      sale_id uuid NOT NULL REFERENCES public.sales(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      product_name text NOT NULL,
      product_type public.product_type NOT NULL,
      quantity numeric(12,3) NOT NULL,
      unit_price numeric(12,2) NOT NULL,
      tax_rate numeric(5,2) NOT NULL DEFAULT 0,
      discount numeric(12,2) NOT NULL DEFAULT 0,
      line_total numeric(12,2) NOT NULL,
      modifiers jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE public.payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      sale_id uuid NOT NULL REFERENCES public.sales(id),
      method public.payment_method NOT NULL,
      amount numeric(12,2) NOT NULL,
      reference text
    );

    CREATE TABLE public.inventory_stocks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      quantity numeric(12,3) NOT NULL DEFAULT 0,
      UNIQUE(branch_id, product_id)
    );
    CREATE TABLE public.inventory_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      movement_type public.movement_type NOT NULL,
      quantity numeric(12,3) NOT NULL,
      reason text,
      reference_type text,
      reference_id uuid,
      user_id uuid REFERENCES auth.users(id)
    );
    CREATE OR REPLACE FUNCTION public.apply_inventory_movement(
      _tenant_id uuid, _branch_id uuid, _product_id uuid,
      _movement_type public.movement_type, _quantity numeric, _reason text,
      _reference_type text, _reference_id uuid, _user_id uuid, _metadata jsonb DEFAULT NULL
    ) RETURNS uuid LANGUAGE plpgsql AS $$
    DECLARE
      _signed numeric;
      _id uuid;
      _new_quantity numeric;
      _allow_negative boolean;
      _dev_mode boolean;
    BEGIN
      _signed := CASE WHEN _movement_type IN ('purchase','production','return') THEN _quantity
                      WHEN _movement_type = 'adjustment' THEN _quantity
                      ELSE -_quantity END;
      SELECT allow_negative_stock, dev_mode
      INTO _allow_negative, _dev_mode
      FROM public.tenants
      WHERE id = _tenant_id;
      INSERT INTO public.inventory_stocks (tenant_id, branch_id, product_id, quantity)
      VALUES (_tenant_id, _branch_id, _product_id, _signed)
      ON CONFLICT (branch_id, product_id) DO UPDATE
        SET quantity = public.inventory_stocks.quantity + EXCLUDED.quantity
      RETURNING quantity INTO _new_quantity;
      IF NOT COALESCE(_allow_negative, false)
         AND NOT COALESCE(_dev_mode, false)
         AND _new_quantity < 0
      THEN
        RAISE EXCEPTION 'Stock insuficiente para el producto %', _product_id;
      END IF;
      INSERT INTO public.inventory_movements
        (tenant_id, branch_id, product_id, movement_type, quantity, reason, reference_type, reference_id, user_id)
      VALUES
        (_tenant_id, _branch_id, _product_id, _movement_type, _quantity, _reason, _reference_type, _reference_id, _user_id)
      RETURNING id INTO _id;
      RETURN _id;
    END $$;

    CREATE TABLE public.discount_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      code text NOT NULL,
      discount_type text NOT NULL DEFAULT 'percentage',
      discount_value numeric(12,2) NOT NULL,
      starts_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      max_uses integer,
      current_uses integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      UNIQUE(tenant_id, code)
    );
    CREATE TABLE public.operation_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid REFERENCES public.branches(id),
      operation_type text NOT NULL,
      client_mutation_id text NOT NULL,
      entity_type text,
      entity_id uuid,
      payload jsonb,
      status text NOT NULL DEFAULT 'success',
      UNIQUE(tenant_id, client_mutation_id)
    );
    CREATE TABLE public.audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid REFERENCES public.tenants(id),
      user_id uuid REFERENCES auth.users(id),
      action text NOT NULL,
      entity text NOT NULL,
      entity_id uuid,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.exec(stageA);
  await db.exec(stageB);
  await db.exec(checkoutV2);
  await db.exec(checkoutCompat);

  await db.exec(`
    INSERT INTO auth.users(id) VALUES ('${IDS.cashier}'), ('${IDS.outsider}');
    INSERT INTO public.tenants(id, dev_mode, points_per_thousand)
      VALUES ('${IDS.tenantA}', false, 0), ('${IDS.tenantB}', false, 0);
    INSERT INTO public.branches(id, tenant_id, status)
      VALUES ('${IDS.branchA}', '${IDS.tenantA}', 'active'), ('${IDS.branchB}', '${IDS.tenantB}', 'active');
    INSERT INTO public.user_roles(user_id, tenant_id, branch_id, role)
      VALUES ('${IDS.cashier}', '${IDS.tenantA}', '${IDS.branchA}', 'cashier');
    INSERT INTO public.cash_sessions(id, tenant_id, branch_id, user_id, status)
      VALUES
        ('${IDS.sessionA}', '${IDS.tenantA}', '${IDS.branchA}', '${IDS.cashier}', 'open'),
        ('${IDS.closedSession}', '${IDS.tenantA}', '${IDS.branchA}', '${IDS.cashier}', 'closed');
    INSERT INTO public.products(id, tenant_id, name, product_type, price, cost, tax_rate, status)
      VALUES ('${IDS.productA}', '${IDS.tenantA}', 'Exact BHD Product', 'simple', 1.025, 0.500, 10.00, 'active');
    INSERT INTO public.inventory_stocks(tenant_id, branch_id, product_id, quantity)
      VALUES ('${IDS.tenantA}', '${IDS.branchA}', '${IDS.productA}', 10.000);
    INSERT INTO public.customers(id, tenant_id, name)
      VALUES ('${IDS.customerA}', '${IDS.tenantA}', 'Tenant A Customer'),
             ('${IDS.customerB}', '${IDS.tenantB}', 'Tenant B Customer');
    SELECT set_config('request.jwt.claim.sub', '${IDS.cashier}', false);
  `);

  const first = await db.query(checkoutSql({ operationId: "checkout-core-0001" }));
  const saleId = first.rows[0].sale_id;
  if (!saleId) throw new Error("Checkout did not return a sale ID");

  const sale = await db.query(`
    SELECT subtotal, subtotal_fils, tax_total, tax_total_fils,
           total, total_fils, session_id, tenant_id, branch_id
    FROM public.sales WHERE id = '${saleId}'
  `);
  const row = sale.rows[0];
  if (
    row.subtotal_fils !== 1_025
    || row.tax_total_fils !== 103
    || row.total_fils !== 1_128
    || row.subtotal !== "1.025"
    || row.total !== "1.128"
    || row.session_id !== IDS.sessionA
  ) {
    throw new Error(`Server-authoritative fils totals are wrong: ${JSON.stringify(row)}`);
  }

  const item = await db.query(`
    SELECT unit_price, unit_price_fils, tax_rate, line_total_fils
    FROM public.sale_items WHERE sale_id = '${saleId}'
  `);
  if (
    item.rows[0].unit_price !== "1.025"
    || item.rows[0].unit_price_fils !== 1_025
    || Number(item.rows[0].tax_rate) !== 10
    || item.rows[0].line_total_fils !== 1_128
  ) {
    throw new Error(`Client price/tax was trusted or server resolution is wrong: ${JSON.stringify(item.rows[0])}`);
  }

  const payment = await db.query(`
    SELECT
      count(*)::int AS count,
      sum(amount_fils)::bigint AS total_fils,
      sum(amount_fils) FILTER (WHERE method = 'cash')::bigint AS cash_fils,
      sum(amount_fils) FILTER (WHERE method = 'card')::bigint AS card_fils,
      sum(amount_fils) FILTER (WHERE method = 'qr')::bigint AS qr_fils,
      sum(amount_fils) FILTER (WHERE method = 'transfer')::bigint AS transfer_fils
    FROM public.payments WHERE sale_id = '${saleId}'
  `);
  if (
    payment.rows[0].count !== 4
    || payment.rows[0].total_fils !== 1_128
    || payment.rows[0].cash_fils !== 500
    || payment.rows[0].card_fils !== 300
    || payment.rows[0].qr_fils !== 250
    || payment.rows[0].transfer_fils !== 78
  ) {
    throw new Error(`Split allocations were not persisted exactly: ${JSON.stringify(payment.rows[0])}`);
  }

  const tillBuckets = await db.query(`
    SELECT total_cash, total_cash_fils,
           total_card, total_card_fils,
           total_qr, total_qr_fils,
           total_transfer, total_transfer_fils
    FROM public.cash_sessions WHERE id = '${IDS.sessionA}'
  `);
  if (
    tillBuckets.rows[0].total_cash !== "0.500"
    || tillBuckets.rows[0].total_cash_fils !== 500
    || tillBuckets.rows[0].total_card !== "0.300"
    || tillBuckets.rows[0].total_card_fils !== 300
    || tillBuckets.rows[0].total_qr !== "0.250"
    || tillBuckets.rows[0].total_qr_fils !== 250
    || tillBuckets.rows[0].total_transfer !== "0.078"
    || tillBuckets.rows[0].total_transfer_fils !== 78
  ) {
    throw new Error(`Split allocations contaminated cash-session buckets: ${JSON.stringify(tillBuckets.rows[0])}`);
  }

  const stock = await db.query(`
    SELECT quantity FROM public.inventory_stocks
    WHERE branch_id = '${IDS.branchA}' AND product_id = '${IDS.productA}'
  `);
  const movements = await db.query(`
    SELECT count(*)::int AS count FROM public.inventory_movements
    WHERE reference_id = '${saleId}' AND movement_type = 'sale'
  `);
  if (stock.rows[0].quantity !== "9.000" || movements.rows[0].count !== 1) {
    throw new Error(`Inventory did not move exactly once: stock=${JSON.stringify(stock.rows[0])}, movements=${JSON.stringify(movements.rows[0])}`);
  }

  const replay = await db.query(checkoutSql({ operationId: "checkout-core-0001" }));
  if (replay.rows[0].sale_id !== saleId) {
    throw new Error(`Idempotent replay returned a different sale: ${JSON.stringify(replay.rows[0])}`);
  }
  const replayCounts = await db.query(`
    SELECT
      (SELECT count(*)::int FROM public.sales WHERE client_mutation_id = 'checkout-core-0001') AS sales,
      (SELECT count(*)::int FROM public.payments WHERE sale_id = '${saleId}') AS payments,
      (SELECT count(*)::int FROM public.inventory_movements WHERE reference_id = '${saleId}') AS movements
  `);
  if (replayCounts.rows[0].sales !== 1 || replayCounts.rows[0].payments !== 4 || replayCounts.rows[0].movements !== 1) {
    throw new Error(`Replay duplicated financial effects: ${JSON.stringify(replayCounts.rows[0])}`);
  }

  const replayTillBuckets = await db.query(`
    SELECT total_cash_fils, total_card_fils, total_qr_fils, total_transfer_fils
    FROM public.cash_sessions WHERE id = '${IDS.sessionA}'
  `);
  if (
    replayTillBuckets.rows[0].total_cash_fils !== 500
    || replayTillBuckets.rows[0].total_card_fils !== 300
    || replayTillBuckets.rows[0].total_qr_fils !== 250
    || replayTillBuckets.rows[0].total_transfer_fils !== 78
  ) {
    throw new Error(`Idempotent replay duplicated till buckets: ${JSON.stringify(replayTillBuckets.rows[0])}`);
  }

  // Model an offline sale whose last cached quantity is stale. The production
  // inventory command rejects negative stock when the tenant has not opted in,
  // and the entire checkout statement must roll back without financial effects.
  await db.exec(`
    UPDATE public.inventory_stocks
    SET quantity = 0
    WHERE branch_id = '${IDS.branchA}' AND product_id = '${IDS.productA}';
  `);
  await expectReject(
    "stale offline stock",
    checkoutSql({ operationId: "checkout-core-0006" }),
    "Stock insuficiente",
  );
  const staleStockRollback = await db.query(`
    SELECT
      (SELECT quantity FROM public.inventory_stocks
       WHERE branch_id = '${IDS.branchA}' AND product_id = '${IDS.productA}') AS quantity,
      (SELECT count(*)::int FROM public.sales
       WHERE client_mutation_id = 'checkout-core-0006') AS sales,
      (SELECT count(*)::int FROM public.checkout_operations
       WHERE client_mutation_id = 'checkout-core-0006') AS operations
  `);
  if (
    staleStockRollback.rows[0].quantity !== "0.000"
    || staleStockRollback.rows[0].sales !== 0
    || staleStockRollback.rows[0].operations !== 0
  ) {
    throw new Error(`Stale-stock rejection left partial effects: ${JSON.stringify(staleStockRollback.rows[0])}`);
  }
  await db.exec(`
    UPDATE public.inventory_stocks
    SET quantity = 9.000
    WHERE branch_id = '${IDS.branchA}' AND product_id = '${IDS.productA}';
  `);

  await expectReject(
    "coupon changed while offline",
    checkoutSql({ operationId: "checkout-core-0007", couponCode: "EXPIRED" }),
    "Coupon is invalid, expired, or exhausted",
  );
  await expectNoCheckoutEffects("checkout-core-0007");

  await db.exec(`UPDATE public.products SET status = 'inactive' WHERE id = '${IDS.productA}';`);
  await expectReject(
    "product became inactive while offline",
    checkoutSql({ operationId: "checkout-core-0008" }),
    "unavailable for this branch",
  );
  await expectNoCheckoutEffects("checkout-core-0008");
  await db.exec(`UPDATE public.products SET status = 'active' WHERE id = '${IDS.productA}';`);

  await db.exec(`UPDATE public.products SET price = 1.125 WHERE id = '${IDS.productA}';`);
  await expectReject(
    "price changed while offline",
    checkoutSql({ operationId: "checkout-core-0009" }),
    "must exactly equal sale total",
  );
  await expectNoCheckoutEffects("checkout-core-0009");
  await db.exec(`UPDATE public.products SET price = 1.025 WHERE id = '${IDS.productA}';`);

  await db.exec(`UPDATE public.branches SET status = 'inactive' WHERE id = '${IDS.branchA}';`);
  await expectReject(
    "branch changed while offline",
    checkoutSql({ operationId: "checkout-core-0010" }),
    "Branch is not active for this business",
  );
  await expectNoCheckoutEffects("checkout-core-0010");
  await db.exec(`UPDATE public.branches SET status = 'active' WHERE id = '${IDS.branchA}';`);

  await expectReject(
    "operation ID payload mismatch",
    checkoutSql({ operationId: "checkout-core-0001", quantity: "2.000" }),
    "already used for a different checkout request",
  );
  await expectReject(
    "one-fils payment mismatch",
    checkoutSql({ operationId: "checkout-core-0002", payments: [{ method: "cash", amount_fils: 1_127 }] }),
    "must exactly equal sale total",
  );
  await expectReject(
    "cross-tenant customer",
    checkoutSql({ operationId: "checkout-core-0003", customerId: IDS.customerB }),
    "Customer does not belong to this business",
  );
  await expectReject(
    "closed cash session",
    checkoutSql({ operationId: "checkout-core-0004", sessionId: IDS.closedSession }),
    "selected cash session is not open",
  );

  await db.exec(`SELECT set_config('request.jwt.claim.sub', '${IDS.outsider}', false);`);
  await expectReject(
    "unauthorized actor",
    checkoutSql({ operationId: "checkout-core-0005" }),
    "Forbidden",
  );

  const audit = await db.query(`
    SELECT count(*)::int AS count FROM public.audit_logs
    WHERE action = 'sale.checkout_committed' AND entity_id = '${saleId}'
  `);
  if (audit.rows[0].count !== 1) {
    throw new Error(`Checkout audit event missing or duplicated: ${JSON.stringify(audit.rows[0])}`);
  }

  // Installed clients still use the legacy decimal checkout_sale signature.
  // Execute that exact path after the compatibility migration and prove it is
  // only an adapter into the same authoritative v2 transaction core.
  await db.exec(`SELECT set_config('request.jwt.claim.sub', '${IDS.cashier}', false);`);
  const compatFirst = await db.query(legacyCheckoutSql({ operationId: "checkout-compat-0001" }));
  const compatSaleId = compatFirst.rows[0].sale_id;
  if (!compatSaleId) throw new Error("Compatibility checkout did not return a sale ID");

  const compatSale = await db.query(`
    SELECT subtotal, subtotal_fils, tax_total, tax_total_fils, total, total_fils, session_id
    FROM public.sales WHERE id = '${compatSaleId}'
  `);
  const compatRow = compatSale.rows[0];
  if (
    compatRow.subtotal !== "1.025"
    || compatRow.subtotal_fils !== 1_025
    || compatRow.tax_total_fils !== 103
    || compatRow.total !== "1.128"
    || compatRow.total_fils !== 1_128
    || compatRow.session_id !== IDS.sessionA
  ) {
    throw new Error(`Compatibility adapter changed authoritative totals: ${JSON.stringify(compatRow)}`);
  }

  const compatItem = await db.query(`
    SELECT unit_price, unit_price_fils, tax_rate, line_total_fils
    FROM public.sale_items WHERE sale_id = '${compatSaleId}'
  `);
  if (
    compatItem.rows[0].unit_price !== "1.025"
    || compatItem.rows[0].unit_price_fils !== 1_025
    || Number(compatItem.rows[0].tax_rate) !== 10
    || compatItem.rows[0].line_total_fils !== 1_128
  ) {
    throw new Error(`Compatibility adapter trusted legacy client price/tax: ${JSON.stringify(compatItem.rows[0])}`);
  }

  const compatReplay = await db.query(legacyCheckoutSql({ operationId: "checkout-compat-0001" }));
  if (compatReplay.rows[0].sale_id !== compatSaleId) {
    throw new Error(`Compatibility replay returned a different sale: ${JSON.stringify(compatReplay.rows[0])}`);
  }

  const compatCounts = await db.query(`
    SELECT
      (SELECT count(*)::int FROM public.sales WHERE client_mutation_id = 'checkout-compat-0001') AS sales,
      (SELECT count(*)::int FROM public.payments WHERE sale_id = '${compatSaleId}') AS payments,
      (SELECT count(*)::int FROM public.inventory_movements WHERE reference_id = '${compatSaleId}') AS movements
  `);
  if (compatCounts.rows[0].sales !== 1 || compatCounts.rows[0].payments !== 1 || compatCounts.rows[0].movements !== 1) {
    throw new Error(`Compatibility replay duplicated effects: ${JSON.stringify(compatCounts.rows[0])}`);
  }

  const finalTillBuckets = await db.query(`
    SELECT total_cash_fils, total_card_fils, total_qr_fils, total_transfer_fils
    FROM public.cash_sessions WHERE id = '${IDS.sessionA}'
  `);
  if (
    finalTillBuckets.rows[0].total_cash_fils !== 1_628
    || finalTillBuckets.rows[0].total_card_fils !== 300
    || finalTillBuckets.rows[0].total_qr_fils !== 250
    || finalTillBuckets.rows[0].total_transfer_fils !== 78
  ) {
    throw new Error(`Compatibility checkout or replay corrupted till buckets: ${JSON.stringify(finalTillBuckets.rows[0])}`);
  }

  await expectReject(
    "compatibility one-fils payment mismatch",
    legacyCheckoutSql({ operationId: "checkout-compat-0002", paymentAmount: "1.127" }),
    "must exactly equal sale total",
  );

  await db.exec(`
    INSERT INTO public.cash_sessions(id, tenant_id, branch_id, user_id, status)
    VALUES (gen_random_uuid(), '${IDS.tenantA}', '${IDS.branchA}', '${IDS.cashier}', 'open');
  `);
  await expectReject(
    "compatibility ambiguous cash session",
    legacyCheckoutSql({ operationId: "checkout-compat-0003" }),
    "Multiple open cash sessions exist for this branch",
  );

  console.log("PASS: checkout v2 enforces exact mixed-payment persistence and till buckets, authoritative pricing, stale-state rejection, tenant/session scope, and exactly-once effects.");
} finally {
  await db.close();
}
