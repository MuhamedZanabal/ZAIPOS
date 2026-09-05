import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("../supabase/migrations/20260905100000_return_refund_v2.sql", import.meta.url);
let migration;
try {
  migration = await readFile(migrationUrl, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error("P0.6 migration missing: process_sale_return_v2 is not implemented");
  }
  throw error;
}

const db = new PGlite();

const IDS = {
  tenantA: "10000000-0000-0000-0000-000000000001",
  tenantB: "10000000-0000-0000-0000-000000000002",
  branchA: "20000000-0000-0000-0000-000000000001",
  branchB: "20000000-0000-0000-0000-000000000002",
  managerA: "30000000-0000-0000-0000-000000000001",
  cashierA: "30000000-0000-0000-0000-000000000002",
  managerB: "30000000-0000-0000-0000-000000000003",
  sessionA: "40000000-0000-0000-0000-000000000001",
  closedSessionA: "40000000-0000-0000-0000-000000000002",
  sessionB: "40000000-0000-0000-0000-000000000003",
  product1: "50000000-0000-0000-0000-000000000001",
  product2: "50000000-0000-0000-0000-000000000002",
  sale: "60000000-0000-0000-0000-000000000001",
  item1: "70000000-0000-0000-0000-000000000001",
  item2: "70000000-0000-0000-0000-000000000002",
  cashPayment: "80000000-0000-0000-0000-000000000001",
  cardPayment: "80000000-0000-0000-0000-000000000002",
  qrPayment: "80000000-0000-0000-0000-000000000003",
  transferPayment: "80000000-0000-0000-0000-000000000004",
};

async function asUser(userId) {
  await db.exec(`SET request.jwt.claim.sub = '${userId}'`);
}

async function expectReject(label, sql, expectedMessage) {
  let rejected = false;
  try {
    await db.query(sql);
  } catch (error) {
    rejected = true;
    const message = String(error?.message ?? error);
    if (!message.toLowerCase().includes(expectedMessage.toLowerCase())) {
      throw new Error(`${label}: expected ${JSON.stringify(expectedMessage)}, got ${message}`);
    }
  }
  if (!rejected) throw new Error(`${label}: expected return/refund to be rejected`);
}

function returnSql({
  operationId,
  items,
  sessionId = IDS.sessionA,
  reasonCode = "customer_request",
  reason = "Customer return",
} = {}) {
  return `SELECT public.process_sale_return_v2(
    '${IDS.sale}'::uuid,
    '${JSON.stringify(items)}'::jsonb,
    '${reasonCode}',
    '${operationId}',
    ${sessionId ? `'${sessionId}'::uuid` : "NULL::uuid"},
    '${reason.replaceAll("'", "''")}',
    NULL
  ) AS return_id`;
}

async function one(sql) {
  const result = await db.query(sql);
  return result.rows[0];
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
    CREATE OR REPLACE FUNCTION auth.role()
    RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated'::text $$;

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
      allow_negative_stock boolean NOT NULL DEFAULT false
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

    CREATE OR REPLACE FUNCTION public.bhd_numeric_to_fils(_amount numeric)
    RETURNS bigint LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT round(_amount * 1000)::bigint $$;
    CREATE OR REPLACE FUNCTION public.fils_to_bhd_numeric(_amount_fils bigint)
    RETURNS numeric LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT _amount_fils::numeric / 1000 $$;
    CREATE OR REPLACE FUNCTION public.sync_fils_columns_from_numeric()
    RETURNS trigger LANGUAGE plpgsql AS $$
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
            CASE WHEN _legacy_amount IS NULL THEN 'null'::jsonb
                 ELSE to_jsonb(public.bhd_numeric_to_fils(_legacy_amount::numeric)) END
          );
        END IF;
      END LOOP;
      NEW := jsonb_populate_record(NEW, _new_row);
      RETURN NEW;
    END;
    $$;

    CREATE TABLE public.products (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      name text NOT NULL,
      product_type public.product_type NOT NULL DEFAULT 'simple'
    );
    CREATE TABLE public.cash_sessions (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      user_id uuid NOT NULL REFERENCES auth.users(id),
      opening_amount numeric(14,3) NOT NULL DEFAULT 0,
      opening_amount_fils bigint NOT NULL DEFAULT 0,
      total_cash numeric(14,3) NOT NULL DEFAULT 0,
      total_cash_fils bigint NOT NULL DEFAULT 0,
      total_card numeric(14,3) NOT NULL DEFAULT 0,
      total_card_fils bigint NOT NULL DEFAULT 0,
      total_transfer numeric(14,3) NOT NULL DEFAULT 0,
      total_transfer_fils bigint NOT NULL DEFAULT 0,
      total_qr numeric(14,3) NOT NULL DEFAULT 0,
      total_qr_fils bigint NOT NULL DEFAULT 0,
      total_in numeric(14,3) NOT NULL DEFAULT 0,
      total_in_fils bigint NOT NULL DEFAULT 0,
      total_out numeric(14,3) NOT NULL DEFAULT 0,
      total_out_fils bigint NOT NULL DEFAULT 0,
      status public.cash_session_status NOT NULL DEFAULT 'open'
    );
    CREATE TRIGGER sync_cash_session_test_fils BEFORE INSERT OR UPDATE ON public.cash_sessions
    FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
      '{"opening_amount":"opening_amount_fils","total_cash":"total_cash_fils","total_card":"total_card_fils","total_transfer":"total_transfer_fils","total_qr":"total_qr_fils","total_in":"total_in_fils","total_out":"total_out_fils"}'
    );

    CREATE TABLE public.sales (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      session_id uuid REFERENCES public.cash_sessions(id),
      user_id uuid NOT NULL REFERENCES auth.users(id),
      subtotal numeric(14,3) NOT NULL DEFAULT 0,
      subtotal_fils bigint NOT NULL DEFAULT 0,
      tax_total numeric(14,3) NOT NULL DEFAULT 0,
      tax_total_fils bigint NOT NULL DEFAULT 0,
      discount_total numeric(14,3) NOT NULL DEFAULT 0,
      discount_total_fils bigint NOT NULL DEFAULT 0,
      tip_amount numeric(14,3) NOT NULL DEFAULT 0,
      tip_amount_fils bigint NOT NULL DEFAULT 0,
      total numeric(14,3) NOT NULL DEFAULT 0,
      total_fils bigint NOT NULL DEFAULT 0,
      status public.sale_status NOT NULL DEFAULT 'completed',
      channel public.sales_channel NOT NULL DEFAULT 'pos',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.sale_items (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      sale_id uuid NOT NULL REFERENCES public.sales(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      product_name text NOT NULL,
      product_type public.product_type NOT NULL,
      quantity numeric(12,3) NOT NULL,
      unit_price numeric(14,3) NOT NULL,
      unit_price_fils bigint NOT NULL,
      tax_rate numeric(5,2) NOT NULL DEFAULT 0,
      discount numeric(14,3) NOT NULL DEFAULT 0,
      discount_fils bigint NOT NULL DEFAULT 0,
      line_total numeric(14,3) NOT NULL,
      line_total_fils bigint NOT NULL
    );
    CREATE TABLE public.payments (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      sale_id uuid NOT NULL REFERENCES public.sales(id),
      method public.payment_method NOT NULL,
      amount numeric(14,3) NOT NULL,
      amount_fils bigint NOT NULL,
      reference text
    );
    CREATE TABLE public.sale_returns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      original_sale_id uuid NOT NULL REFERENCES public.sales(id),
      reason text,
      amount numeric(14,3) NOT NULL DEFAULT 0,
      items jsonb,
      user_id uuid,
      supervisor_user_id uuid,
      evidence_url text,
      refund_method text,
      status text NOT NULL DEFAULT 'completed',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.sale_returns ENABLE ROW LEVEL SECURITY;
    CREATE POLICY returns_member_select ON public.sale_returns FOR SELECT TO authenticated USING (true);
    CREATE POLICY returns_admin_all ON public.sale_returns FOR ALL TO authenticated USING (true) WITH CHECK (true);

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
      _reference_type text, _reference_id uuid, _user_id uuid,
      _inventory_center_id uuid DEFAULT NULL
    ) RETURNS uuid LANGUAGE plpgsql AS $$
    DECLARE _movement_id uuid; BEGIN
      IF _movement_type <> 'return'::public.movement_type THEN
        RAISE EXCEPTION 'test harness only supports return movements';
      END IF;
      UPDATE public.inventory_stocks
      SET quantity = quantity + _quantity
      WHERE tenant_id = _tenant_id AND branch_id = _branch_id AND product_id = _product_id;
      IF NOT FOUND THEN
        INSERT INTO public.inventory_stocks (tenant_id, branch_id, product_id, quantity)
        VALUES (_tenant_id, _branch_id, _product_id, _quantity);
      END IF;
      INSERT INTO public.inventory_movements (
        tenant_id, branch_id, product_id, movement_type, quantity, reason, reference_type, reference_id, user_id
      ) VALUES (
        _tenant_id, _branch_id, _product_id, _movement_type, _quantity, _reason, _reference_type, _reference_id, _user_id
      ) RETURNING id INTO _movement_id;
      RETURN _movement_id;
    END;
    $$;

    CREATE TABLE public.audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      user_id uuid,
      action text NOT NULL,
      entity text NOT NULL,
      entity_id uuid,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.exec(migration);

  await db.exec(`
    INSERT INTO auth.users (id) VALUES
      ('${IDS.managerA}'), ('${IDS.cashierA}'), ('${IDS.managerB}');
    INSERT INTO public.tenants (id) VALUES ('${IDS.tenantA}'), ('${IDS.tenantB}');
    INSERT INTO public.branches (id, tenant_id) VALUES
      ('${IDS.branchA}', '${IDS.tenantA}'), ('${IDS.branchB}', '${IDS.tenantB}');
    INSERT INTO public.user_roles (user_id, tenant_id, branch_id, role) VALUES
      ('${IDS.managerA}', '${IDS.tenantA}', '${IDS.branchA}', 'manager'),
      ('${IDS.cashierA}', '${IDS.tenantA}', '${IDS.branchA}', 'cashier'),
      ('${IDS.managerB}', '${IDS.tenantB}', '${IDS.branchB}', 'manager');
    INSERT INTO public.products (id, tenant_id, name, product_type) VALUES
      ('${IDS.product1}', '${IDS.tenantA}', 'Product 1', 'simple'),
      ('${IDS.product2}', '${IDS.tenantA}', 'Product 2', 'simple');
    INSERT INTO public.cash_sessions (
      id, tenant_id, branch_id, user_id, opening_amount,
      total_cash, total_card, total_qr, total_transfer, status
    ) VALUES
      ('${IDS.sessionA}', '${IDS.tenantA}', '${IDS.branchA}', '${IDS.managerA}', 5.000, 20.000, 10.000, 5.000, 3.000, 'open'),
      ('${IDS.closedSessionA}', '${IDS.tenantA}', '${IDS.branchA}', '${IDS.managerA}', 5.000, 20.000, 10.000, 5.000, 3.000, 'closed'),
      ('${IDS.sessionB}', '${IDS.tenantB}', '${IDS.branchB}', '${IDS.managerB}', 5.000, 20.000, 10.000, 5.000, 3.000, 'open');
    INSERT INTO public.sales (
      id, tenant_id, branch_id, session_id, user_id,
      subtotal, subtotal_fils, tax_total, tax_total_fils,
      discount_total, discount_total_fils, tip_amount, tip_amount_fils,
      total, total_fils, status, channel
    ) VALUES (
      '${IDS.sale}', '${IDS.tenantA}', '${IDS.branchA}', '${IDS.sessionA}', '${IDS.managerA}',
      11.000, 11000, 0.000, 0,
      1.000, 1000, 0.250, 250,
      10.250, 10250, 'completed', 'pos'
    );
    INSERT INTO public.sale_items (
      id, tenant_id, sale_id, product_id, product_name, product_type, quantity,
      unit_price, unit_price_fils, tax_rate, discount, discount_fils, line_total, line_total_fils
    ) VALUES
      ('${IDS.item1}', '${IDS.tenantA}', '${IDS.sale}', '${IDS.product1}', 'Product 1', 'simple', 2.000, 3.000, 3000, 0, 0, 0, 6.000, 6000),
      ('${IDS.item2}', '${IDS.tenantA}', '${IDS.sale}', '${IDS.product2}', 'Product 2', 'simple', 1.000, 5.000, 5000, 0, 0, 0, 5.000, 5000);
    INSERT INTO public.payments (id, tenant_id, sale_id, method, amount, amount_fils) VALUES
      ('${IDS.cashPayment}', '${IDS.tenantA}', '${IDS.sale}', 'cash', 5.000, 5000),
      ('${IDS.cardPayment}', '${IDS.tenantA}', '${IDS.sale}', 'card', 3.000, 3000),
      ('${IDS.qrPayment}', '${IDS.tenantA}', '${IDS.sale}', 'qr', 1.500, 1500),
      ('${IDS.transferPayment}', '${IDS.tenantA}', '${IDS.sale}', 'transfer', 0.750, 750);
    INSERT INTO public.inventory_stocks (tenant_id, branch_id, product_id, quantity) VALUES
      ('${IDS.tenantA}', '${IDS.branchA}', '${IDS.product1}', 8.000),
      ('${IDS.tenantA}', '${IDS.branchA}', '${IDS.product2}', 9.000);
  `);

  await asUser(IDS.managerA);

  const first = await one(returnSql({
    operationId: "return-op-0001",
    items: [{ sale_item_id: IDS.item1, quantity: "1.000" }],
  }));
  const firstReturnId = first.return_id;
  const firstState = await one(`
    SELECT
      r.amount_fils,
      (SELECT sum(amount_fils)::bigint FROM public.payment_refunds WHERE return_id = r.id) AS payment_refund_fils,
      (SELECT quantity FROM public.inventory_stocks WHERE product_id = '${IDS.product1}' AND branch_id = '${IDS.branchA}') AS stock,
      (SELECT count(*)::int FROM public.inventory_movements WHERE reference_type = 'sale_return_item' AND movement_type = 'return') AS return_movements,
      (SELECT total_cash_fils FROM public.cash_sessions WHERE id = '${IDS.sessionA}') AS cash_fils,
      (SELECT total_card_fils FROM public.cash_sessions WHERE id = '${IDS.sessionA}') AS card_fils,
      (SELECT total_qr_fils FROM public.cash_sessions WHERE id = '${IDS.sessionA}') AS qr_fils,
      (SELECT total_transfer_fils FROM public.cash_sessions WHERE id = '${IDS.sessionA}') AS transfer_fils,
      (SELECT status::text FROM public.sales WHERE id = '${IDS.sale}') AS sale_status
    FROM public.sale_returns r WHERE r.id = '${firstReturnId}'
  `);
  if (Number(firstState.amount_fils) !== 2728 || Number(firstState.payment_refund_fils) !== 2728) {
    throw new Error(`partial return did not preserve exact fils: ${JSON.stringify(firstState)}`);
  }
  if (Number(firstState.stock) !== 9 || firstState.return_movements !== 1 || firstState.sale_status !== "partially_refunded") {
    throw new Error(`partial return effects are wrong: ${JSON.stringify(firstState)}`);
  }

  const firstAllocations = await db.query(`
    SELECT method::text, amount_fils FROM public.payment_refunds
    WHERE return_id = '${firstReturnId}' ORDER BY method::text
  `);
  const allocationMap = Object.fromEntries(firstAllocations.rows.map((row) => [row.method, Number(row.amount_fils)]));
  const expectedAllocation = { cash: 1331, card: 798, qr: 399, transfer: 200 };
  for (const [method, amount] of Object.entries(expectedAllocation)) {
    if (allocationMap[method] !== amount) {
      throw new Error(`expected ${method} refund ${amount} fils, got ${allocationMap[method]}`);
    }
  }
  if (
    Number(firstState.cash_fils) !== 20000 - expectedAllocation.cash
    || Number(firstState.card_fils) !== 10000 - expectedAllocation.card
    || Number(firstState.qr_fils) !== 5000 - expectedAllocation.qr
    || Number(firstState.transfer_fils) !== 3000 - expectedAllocation.transfer
  ) {
    throw new Error(`split till buckets were not reduced independently: ${JSON.stringify(firstState)}`);
  }

  const replay = await one(returnSql({
    operationId: "return-op-0001",
    items: [{ sale_item_id: IDS.item1, quantity: "1.000" }],
  }));
  if (replay.return_id !== firstReturnId) throw new Error("idempotent replay did not return the original return ID");
  const replayEffects = await one(`
    SELECT
      (SELECT count(*)::int FROM public.sale_returns WHERE original_sale_id = '${IDS.sale}') AS returns,
      (SELECT count(*)::int FROM public.payment_refunds WHERE return_id = '${firstReturnId}') AS payment_refunds,
      (SELECT count(*)::int FROM public.inventory_movements WHERE reference_type = 'sale_return_item') AS movements,
      (SELECT quantity FROM public.inventory_stocks WHERE product_id = '${IDS.product1}' AND branch_id = '${IDS.branchA}') AS stock
  `);
  if (replayEffects.returns !== 1 || replayEffects.payment_refunds !== 4 || replayEffects.movements !== 1 || Number(replayEffects.stock) !== 9) {
    throw new Error(`idempotent replay duplicated financial effects: ${JSON.stringify(replayEffects)}`);
  }

  await expectReject(
    "operation ID payload mismatch",
    returnSql({ operationId: "return-op-0001", items: [{ sale_item_id: IDS.item1, quantity: "0.500" }] }),
    "different return request",
  );

  const second = await one(returnSql({
    operationId: "return-op-0002",
    items: [{ sale_item_id: IDS.item1, quantity: "1.000" }],
  }));
  const secondState = await one(`SELECT amount_fils FROM public.sale_returns WHERE id = '${second.return_id}'`);
  if (Number(secondState.amount_fils) !== 2727) {
    throw new Error(`cumulative partial return drifted: expected 2727 fils, got ${secondState.amount_fils}`);
  }

  await expectReject(
    "cumulative item ceiling",
    returnSql({ operationId: "return-op-excess", items: [{ sale_item_id: IDS.item1, quantity: "0.001" }] }),
    "exceeds remaining refundable quantity",
  );

  const third = await one(returnSql({
    operationId: "return-op-0003",
    items: [{ sale_item_id: IDS.item2, quantity: "1.000" }],
  }));
  const finalState = await one(`
    SELECT
      (SELECT sum(amount_fils)::bigint FROM public.sale_returns WHERE original_sale_id = '${IDS.sale}' AND status = 'completed') AS returned_fils,
      (SELECT sum(amount_fils)::bigint FROM public.payment_refunds pr JOIN public.sale_returns r ON r.id = pr.return_id WHERE r.original_sale_id = '${IDS.sale}') AS payment_refunded_fils,
      (SELECT total_fils FROM public.sales WHERE id = '${IDS.sale}') AS original_total_fils,
      (SELECT sum(amount_fils)::bigint FROM public.payments WHERE sale_id = '${IDS.sale}') AS original_payments_fils,
      (SELECT status::text FROM public.sales WHERE id = '${IDS.sale}') AS sale_status,
      (SELECT count(*)::int FROM public.audit_logs WHERE action = 'sale.returned_v2') AS audits
  `);
  if (Number(finalState.returned_fils) !== 10000 || Number(finalState.payment_refunded_fils) !== 10000) {
    throw new Error(`full merchandise return must equal exactly 10000 fils: ${JSON.stringify(finalState)}`);
  }
  if (Number(finalState.original_total_fils) !== 10250 || Number(finalState.original_payments_fils) !== 10250) {
    throw new Error(`return destructively mutated original financial history: ${JSON.stringify(finalState)}`);
  }
  if (finalState.sale_status !== "refunded" || finalState.audits !== 3) {
    throw new Error(`final lifecycle state/audit is wrong: ${JSON.stringify(finalState)}`);
  }
  const thirdState = await one(`SELECT amount_fils FROM public.sale_returns WHERE id = '${third.return_id}'`);
  if (Number(thirdState.amount_fils) !== 4545) throw new Error(`discount allocation expected 4545 fils, got ${thirdState.amount_fils}`);

  await asUser(IDS.cashierA);
  await expectReject(
    "cashier authorization",
    returnSql({ operationId: "return-op-cashier", items: [{ sale_item_id: IDS.item1, quantity: "0.001" }] }),
    "Forbidden",
  );

  await asUser(IDS.managerB);
  await expectReject(
    "cross-tenant authorization",
    returnSql({ operationId: "return-op-cross-tenant", items: [{ sale_item_id: IDS.item1, quantity: "0.001" }], sessionId: IDS.sessionB }),
    "Forbidden",
  );

  await asUser(IDS.managerA);
  await expectReject(
    "wrong branch cash session",
    returnSql({ operationId: "return-op-wrong-session", items: [{ sale_item_id: IDS.item1, quantity: "0.001" }], sessionId: IDS.sessionB }),
    "cash session",
  );
  await expectReject(
    "closed cash session",
    returnSql({ operationId: "return-op-closed-session", items: [{ sale_item_id: IDS.item1, quantity: "0.001" }], sessionId: IDS.closedSessionA }),
    "cash session",
  );

  console.log("PASS: return/refund v2 enforces exact fils, cumulative ceilings, original-payment allocation, manager authorization, idempotency, exactly-once stock/till effects, and immutable original financial history.");
} finally {
  await db.close();
}
