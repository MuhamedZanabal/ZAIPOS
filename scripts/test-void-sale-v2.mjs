import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("../supabase/migrations/20260905101000_void_sale_v2.sql", import.meta.url);
let migration;
try {
  migration = await readFile(migrationUrl, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error("P0.6 migration missing: process_sale_void_v2 is not implemented");
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
  altSessionA: "40000000-0000-0000-0000-000000000002",
  sessionB: "40000000-0000-0000-0000-000000000003",
  product1: "50000000-0000-0000-0000-000000000001",
  product2: "50000000-0000-0000-0000-000000000002",
  sale: "60000000-0000-0000-0000-000000000001",
  partialSale: "60000000-0000-0000-0000-000000000002",
  customerSale: "60000000-0000-0000-0000-000000000003",
  item1: "70000000-0000-0000-0000-000000000001",
  item2: "70000000-0000-0000-0000-000000000002",
  cashPayment: "80000000-0000-0000-0000-000000000001",
  cardPayment: "80000000-0000-0000-0000-000000000002",
  qrPayment: "80000000-0000-0000-0000-000000000003",
  transferPayment: "80000000-0000-0000-0000-000000000004",
  customer: "90000000-0000-0000-0000-000000000001",
};

async function asUser(userId) {
  await db.exec(`SET request.jwt.claim.sub = '${userId}'`);
}

async function one(sql) {
  const result = await db.query(sql);
  return result.rows[0];
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
  if (!rejected) throw new Error(`${label}: expected void to be rejected`);
}

function voidSql({
  saleId = IDS.sale,
  operationId,
  sessionId = IDS.sessionA,
  reason = "Operator void",
} = {}) {
  return `SELECT public.process_sale_void_v2(
    '${saleId}'::uuid,
    '${operationId}',
    ${sessionId ? `'${sessionId}'::uuid` : "NULL::uuid"},
    '${reason.replaceAll("'", "''")}'
  ) AS void_id`;
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
      id uuid PRIMARY KEY
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

    CREATE TABLE public.customers (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      loyalty_points integer NOT NULL DEFAULT 0
    );
    CREATE TABLE public.discount_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      code text NOT NULL,
      current_uses integer NOT NULL DEFAULT 0,
      UNIQUE(tenant_id, code)
    );
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
      total_cash numeric(14,3) NOT NULL DEFAULT 0,
      total_cash_fils bigint NOT NULL DEFAULT 0,
      total_card numeric(14,3) NOT NULL DEFAULT 0,
      total_card_fils bigint NOT NULL DEFAULT 0,
      total_transfer numeric(14,3) NOT NULL DEFAULT 0,
      total_transfer_fils bigint NOT NULL DEFAULT 0,
      total_qr numeric(14,3) NOT NULL DEFAULT 0,
      total_qr_fils bigint NOT NULL DEFAULT 0,
      status public.cash_session_status NOT NULL DEFAULT 'open'
    );
    CREATE TRIGGER sync_cash_session_void_fils BEFORE INSERT OR UPDATE ON public.cash_sessions
    FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
      '{"total_cash":"total_cash_fils","total_card":"total_card_fils","total_transfer":"total_transfer_fils","total_qr":"total_qr_fils"}'
    );

    CREATE TABLE public.sales (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      session_id uuid REFERENCES public.cash_sessions(id),
      user_id uuid NOT NULL REFERENCES auth.users(id),
      customer_id uuid REFERENCES public.customers(id),
      coupon_code text,
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
      amount_fils bigint NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'completed'
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
    INSERT INTO public.customers (id, tenant_id, loyalty_points)
    VALUES ('${IDS.customer}', '${IDS.tenantA}', 20);
    INSERT INTO public.discount_codes (tenant_id, code, current_uses)
    VALUES ('${IDS.tenantA}', 'SAVE', 4);
    INSERT INTO public.products (id, tenant_id, name, product_type) VALUES
      ('${IDS.product1}', '${IDS.tenantA}', 'Product 1', 'simple'),
      ('${IDS.product2}', '${IDS.tenantA}', 'Product 2', 'simple');
    INSERT INTO public.cash_sessions (
      id, tenant_id, branch_id, user_id, total_cash, total_card, total_qr, total_transfer, status
    ) VALUES
      ('${IDS.sessionA}', '${IDS.tenantA}', '${IDS.branchA}', '${IDS.managerA}', 20.000, 10.000, 5.000, 3.000, 'open'),
      ('${IDS.altSessionA}', '${IDS.tenantA}', '${IDS.branchA}', '${IDS.managerA}', 2.000, 2.000, 2.000, 2.000, 'open'),
      ('${IDS.sessionB}', '${IDS.tenantB}', '${IDS.branchB}', '${IDS.managerB}', 20.000, 10.000, 5.000, 3.000, 'open');
    INSERT INTO public.sales (
      id, tenant_id, branch_id, session_id, user_id, customer_id, coupon_code,
      tip_amount, tip_amount_fils, total, total_fils, status, channel
    ) VALUES
      ('${IDS.sale}', '${IDS.tenantA}', '${IDS.branchA}', '${IDS.sessionA}', '${IDS.managerA}', NULL, 'SAVE', 0.250, 250, 10.250, 10250, 'completed', 'pos'),
      ('${IDS.partialSale}', '${IDS.tenantA}', '${IDS.branchA}', '${IDS.sessionA}', '${IDS.managerA}', NULL, NULL, 0, 0, 1.000, 1000, 'partially_refunded', 'pos'),
      ('${IDS.customerSale}', '${IDS.tenantA}', '${IDS.branchA}', '${IDS.sessionA}', '${IDS.managerA}', '${IDS.customer}', NULL, 0, 0, 1.000, 1000, 'completed', 'pos');
    INSERT INTO public.sale_items (
      id, tenant_id, sale_id, product_id, product_name, product_type, quantity, line_total, line_total_fils
    ) VALUES
      ('${IDS.item1}', '${IDS.tenantA}', '${IDS.sale}', '${IDS.product1}', 'Product 1', 'simple', 2.000, 6.000, 6000),
      ('${IDS.item2}', '${IDS.tenantA}', '${IDS.sale}', '${IDS.product2}', 'Product 2', 'simple', 1.000, 5.000, 5000);
    INSERT INTO public.payments (id, tenant_id, sale_id, method, amount, amount_fils) VALUES
      ('${IDS.cashPayment}', '${IDS.tenantA}', '${IDS.sale}', 'cash', 5.000, 5000),
      ('${IDS.cardPayment}', '${IDS.tenantA}', '${IDS.sale}', 'card', 3.000, 3000),
      ('${IDS.qrPayment}', '${IDS.tenantA}', '${IDS.sale}', 'qr', 1.500, 1500),
      ('${IDS.transferPayment}', '${IDS.tenantA}', '${IDS.sale}', 'transfer', 0.750, 750);
    INSERT INTO public.inventory_stocks (tenant_id, branch_id, product_id, quantity) VALUES
      ('${IDS.tenantA}', '${IDS.branchA}', '${IDS.product1}', 8.000),
      ('${IDS.tenantA}', '${IDS.branchA}', '${IDS.product2}', 9.000);
  `);

  await asUser(IDS.cashierA);
  await expectReject(
    "cashier authorization",
    voidSql({ operationId: "void-op-cashier" }),
    "Forbidden",
  );

  await asUser(IDS.managerB);
  await expectReject(
    "cross-tenant authorization",
    voidSql({ operationId: "void-op-cross-tenant", sessionId: IDS.sessionA }),
    "Forbidden",
  );

  await asUser(IDS.managerA);
  await expectReject(
    "wrong original cash session",
    voidSql({ operationId: "void-op-wrong-session", sessionId: IDS.altSessionA }),
    "original cash session",
  );

  await db.exec(`UPDATE public.cash_sessions SET status = 'closed' WHERE id = '${IDS.sessionA}'`);
  await expectReject(
    "closed original cash session",
    voidSql({ operationId: "void-op-closed-session" }),
    "open original cash session",
  );
  await db.exec(`UPDATE public.cash_sessions SET status = 'open' WHERE id = '${IDS.sessionA}'`);

  await expectReject(
    "partially refunded sale",
    voidSql({ saleId: IDS.partialSale, operationId: "void-op-partial" }),
    "completed uncompensated sale",
  );

  await expectReject(
    "customer-linked sale without loyalty evidence",
    voidSql({ saleId: IDS.customerSale, operationId: "void-op-customer" }),
    "loyalty reversal evidence",
  );

  const first = await one(voidSql({ operationId: "void-op-0001" }));
  const firstVoidId = first.void_id;

  const state = await one(`
    SELECT
      (SELECT total_fils FROM public.sale_voids WHERE id = '${firstVoidId}') AS void_fils,
      (SELECT sum(amount_fils)::bigint FROM public.payment_voids WHERE void_id = '${firstVoidId}') AS payment_void_fils,
      (SELECT count(*)::int FROM public.payment_voids WHERE void_id = '${firstVoidId}') AS payment_voids,
      (SELECT quantity FROM public.inventory_stocks WHERE product_id = '${IDS.product1}' AND branch_id = '${IDS.branchA}') AS stock1,
      (SELECT quantity FROM public.inventory_stocks WHERE product_id = '${IDS.product2}' AND branch_id = '${IDS.branchA}') AS stock2,
      (SELECT count(*)::int FROM public.inventory_movements WHERE reference_type = 'sale_void_item' AND movement_type = 'return') AS stock_movements,
      (SELECT total_cash_fils FROM public.cash_sessions WHERE id = '${IDS.sessionA}') AS cash_fils,
      (SELECT total_card_fils FROM public.cash_sessions WHERE id = '${IDS.sessionA}') AS card_fils,
      (SELECT total_qr_fils FROM public.cash_sessions WHERE id = '${IDS.sessionA}') AS qr_fils,
      (SELECT total_transfer_fils FROM public.cash_sessions WHERE id = '${IDS.sessionA}') AS transfer_fils,
      (SELECT status::text FROM public.sales WHERE id = '${IDS.sale}') AS sale_status,
      (SELECT total_fils FROM public.sales WHERE id = '${IDS.sale}') AS original_total_fils,
      (SELECT sum(amount_fils)::bigint FROM public.payments WHERE sale_id = '${IDS.sale}') AS original_payment_fils,
      (SELECT current_uses FROM public.discount_codes WHERE tenant_id = '${IDS.tenantA}' AND code = 'SAVE') AS coupon_uses,
      (SELECT count(*)::int FROM public.audit_logs WHERE action = 'sale.voided_v2' AND entity_id = '${IDS.sale}') AS audits
  `);

  if (Number(state.void_fils) !== 10250 || Number(state.payment_void_fils) !== 10250 || state.payment_voids !== 4) {
    throw new Error(`void did not reverse the full exact payment total: ${JSON.stringify(state)}`);
  }
  if (Number(state.stock1) !== 10 || Number(state.stock2) !== 10 || state.stock_movements !== 2) {
    throw new Error(`void stock compensation is wrong: ${JSON.stringify(state)}`);
  }
  if (
    Number(state.cash_fils) !== 15000
    || Number(state.card_fils) !== 7000
    || Number(state.qr_fils) !== 3500
    || Number(state.transfer_fils) !== 2250
  ) {
    throw new Error(`void did not reverse till buckets independently: ${JSON.stringify(state)}`);
  }
  if (state.sale_status !== "cancelled" || Number(state.original_total_fils) !== 10250 || Number(state.original_payment_fils) !== 10250) {
    throw new Error(`void mutated original financial history incorrectly: ${JSON.stringify(state)}`);
  }
  if (state.coupon_uses !== 3 || state.audits !== 1) {
    throw new Error(`coupon/audit compensation is wrong: ${JSON.stringify(state)}`);
  }

  const replay = await one(voidSql({ operationId: "void-op-0001" }));
  if (replay.void_id !== firstVoidId) throw new Error("idempotent void replay did not return original void ID");

  const replayState = await one(`
    SELECT
      (SELECT count(*)::int FROM public.sale_voids WHERE sale_id = '${IDS.sale}') AS voids,
      (SELECT count(*)::int FROM public.payment_voids WHERE void_id = '${firstVoidId}') AS payment_voids,
      (SELECT count(*)::int FROM public.inventory_movements WHERE reference_type = 'sale_void_item') AS movements,
      (SELECT current_uses FROM public.discount_codes WHERE tenant_id = '${IDS.tenantA}' AND code = 'SAVE') AS coupon_uses
  `);
  if (replayState.voids !== 1 || replayState.payment_voids !== 4 || replayState.movements !== 2 || replayState.coupon_uses !== 3) {
    throw new Error(`void replay duplicated compensation: ${JSON.stringify(replayState)}`);
  }

  await expectReject(
    "operation ID payload mismatch",
    voidSql({ operationId: "void-op-0001", reason: "Different reason" }),
    "different void request",
  );

  await expectReject(
    "second void operation",
    voidSql({ operationId: "void-op-0002" }),
    "already voided",
  );

  console.log("PASS: void_sale_v2 enforces same-session authorization, exact full-payment compensation, exactly-once stock/till effects, coupon reversal, immutable original history, and replay safety.");
} finally {
  await db.close();
}
