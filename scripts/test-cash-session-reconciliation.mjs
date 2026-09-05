import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../supabase/migrations/20260905104000_cash_session_reconciliation.sql",
  import.meta.url,
);
let migration;
try {
  migration = await readFile(migrationUrl, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error("P0.6 migration missing: exact cash-session reconciliation is not implemented");
  }
  throw error;
}

const db = new PGlite();
const IDS = {
  tenant: "10000000-0000-0000-0000-000000000001",
  branchA: "20000000-0000-0000-0000-000000000001",
  branchB: "20000000-0000-0000-0000-000000000002",
  managerA: "30000000-0000-0000-0000-000000000001",
  managerB: "30000000-0000-0000-0000-000000000002",
  sessionA: "40000000-0000-0000-0000-000000000001",
  precisionSession: "40000000-0000-0000-0000-000000000002",
};

async function asUser(userId) {
  await db.exec(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
}

async function expectReject(label, sql, expected) {
  let rejected = false;
  try {
    await db.query(sql);
  } catch (error) {
    rejected = true;
    const message = String(error?.message ?? error);
    if (!message.toLowerCase().includes(expected.toLowerCase())) {
      throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${message}`);
    }
  }
  if (!rejected) throw new Error(`${label}: expected rejection`);
}

try {
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE anon;
    CREATE SCHEMA auth;

    CREATE OR REPLACE FUNCTION auth.uid()
    RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    CREATE TYPE public.app_role AS ENUM (
      'super_admin','owner','admin','manager','cashier','kitchen','inventory','courier','staff','waiter'
    );
    CREATE TYPE public.cash_session_status AS ENUM ('open','closed');

    CREATE TABLE public.tenants (id uuid PRIMARY KEY);
    CREATE TABLE public.branches (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id)
    );
    CREATE TABLE public.user_roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
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

    CREATE TABLE public.cash_sessions (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      status public.cash_session_status NOT NULL DEFAULT 'open',
      opened_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz,
      opening_amount numeric(18,3) NOT NULL DEFAULT 0,
      opening_amount_fils bigint NOT NULL DEFAULT 0,
      closing_amount numeric(18,3),
      closing_amount_fils bigint,
      expected_amount numeric(18,3),
      expected_amount_fils bigint,
      difference numeric(18,3),
      difference_fils bigint,
      total_cash numeric(18,3) NOT NULL DEFAULT 0,
      total_cash_fils bigint NOT NULL DEFAULT 0,
      total_card numeric(18,3) NOT NULL DEFAULT 0,
      total_card_fils bigint NOT NULL DEFAULT 0,
      total_transfer numeric(18,3) NOT NULL DEFAULT 0,
      total_transfer_fils bigint NOT NULL DEFAULT 0,
      total_qr numeric(18,3) NOT NULL DEFAULT 0,
      total_qr_fils bigint NOT NULL DEFAULT 0,
      total_in numeric(18,3) NOT NULL DEFAULT 0,
      total_in_fils bigint NOT NULL DEFAULT 0,
      total_out numeric(18,3) NOT NULL DEFAULT 0,
      total_out_fils bigint NOT NULL DEFAULT 0,
      counted_cash numeric(18,3),
      counted_cash_fils bigint,
      counted_card numeric(18,3),
      counted_card_fils bigint,
      counted_transfer numeric(18,3),
      counted_transfer_fils bigint,
      counted_qr numeric(18,3),
      counted_qr_fils bigint,
      notes text
    );

    CREATE TRIGGER sync_cash_session_test_fils BEFORE INSERT OR UPDATE ON public.cash_sessions
    FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
      '{"opening_amount":"opening_amount_fils","closing_amount":"closing_amount_fils","expected_amount":"expected_amount_fils","difference":"difference_fils","total_cash":"total_cash_fils","total_card":"total_card_fils","total_transfer":"total_transfer_fils","total_qr":"total_qr_fils","total_in":"total_in_fils","total_out":"total_out_fils","counted_cash":"counted_cash_fils","counted_card":"counted_card_fils","counted_transfer":"counted_transfer_fils","counted_qr":"counted_qr_fils"}'
    );

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

    INSERT INTO public.tenants(id) VALUES ('${IDS.tenant}');
    INSERT INTO public.branches(id, tenant_id) VALUES
      ('${IDS.branchA}', '${IDS.tenant}'),
      ('${IDS.branchB}', '${IDS.tenant}');
    INSERT INTO public.user_roles(user_id, tenant_id, branch_id, role) VALUES
      ('${IDS.managerA}', '${IDS.tenant}', '${IDS.branchA}', 'manager'),
      ('${IDS.managerB}', '${IDS.tenant}', '${IDS.branchB}', 'manager');

    -- This open-session state is the net result of exact mixed-payment sales,
    -- a partial return, a separate full void, and manual cash movement effects:
    -- payment buckets = 5.000 BHD each, opening = 20.000, cash in = 4.025,
    -- cash out = 1.100. Expected cash therefore = 27.925 and expected total = 42.925.
    INSERT INTO public.cash_sessions(
      id, tenant_id, branch_id, opening_amount,
      total_cash, total_card, total_transfer, total_qr, total_in, total_out
    ) VALUES (
      '${IDS.sessionA}', '${IDS.tenant}', '${IDS.branchA}', 20.000,
      5.000, 5.000, 5.000, 5.000, 4.025, 1.100
    ), (
      '${IDS.precisionSession}', '${IDS.tenant}', '${IDS.branchA}', 0.000,
      0.000, 0.000, 0.000, 0.000, 0.000, 0.000
    );
  `);

  await db.exec(migration);
  await asUser(IDS.managerA);

  await expectReject(
    "sub-fils counted input",
    `SELECT public.close_cash_session('${IDS.precisionSession}', 0.0005, NULL, 0, 0, 0)`,
    "three decimal",
  );

  const precisionState = await db.query(`SELECT status::text FROM public.cash_sessions WHERE id = '${IDS.precisionSession}'`);
  if (precisionState.rows[0].status !== "open") {
    throw new Error("sub-fils close attempt mutated the session before rejection");
  }

  await asUser(IDS.managerB);
  await expectReject(
    "cross-branch close",
    `SELECT public.close_cash_session('${IDS.sessionA}', 27.926, NULL, 5, 5, 5)`,
    "Forbidden",
  );

  await asUser(IDS.managerA);
  await db.query(`SELECT public.close_cash_session('${IDS.sessionA}', 27.926, 'P0.6 close', 5.000, 5.000, 5.000)`);

  const result = await db.query(`
    SELECT status::text, opening_amount_fils, total_cash_fils, total_card_fils,
           total_transfer_fils, total_qr_fils, total_in_fils, total_out_fils,
           counted_cash_fils, counted_card_fils, counted_transfer_fils, counted_qr_fils,
           expected_amount_fils, closing_amount_fils, difference_fils
    FROM public.cash_sessions WHERE id = '${IDS.sessionA}'
  `);
  const row = result.rows[0];
  const expected = {
    status: "closed",
    opening_amount_fils: 20000,
    total_cash_fils: 5000,
    total_card_fils: 5000,
    total_transfer_fils: 5000,
    total_qr_fils: 5000,
    total_in_fils: 4025,
    total_out_fils: 1100,
    counted_cash_fils: 27926,
    counted_card_fils: 5000,
    counted_transfer_fils: 5000,
    counted_qr_fils: 5000,
    expected_amount_fils: 42925,
    closing_amount_fils: 42926,
    difference_fils: 1,
  };
  for (const [key, value] of Object.entries(expected)) {
    const actual = key === "status" ? row[key] : Number(row[key]);
    if (actual !== value) throw new Error(`${key}: expected ${value}, got ${actual}`);
  }

  const audit = await db.query(`SELECT metadata FROM public.audit_logs WHERE action = 'cash_session.closed' AND entity_id = '${IDS.sessionA}'`);
  if (audit.rows.length !== 1) throw new Error(`expected exactly one cash close audit, got ${audit.rows.length}`);
  const metadata = audit.rows[0].metadata;
  if (Number(metadata.expected_total_fils) !== 42925 || Number(metadata.counted_total_fils) !== 42926 || Number(metadata.difference_fils) !== 1) {
    throw new Error(`cash close audit lacks exact-fils evidence: ${JSON.stringify(metadata)}`);
  }

  await expectReject(
    "second close",
    `SELECT public.close_cash_session('${IDS.sessionA}', 27.926, NULL, 5, 5, 5)`,
    "already closed",
  );

  console.log("PASS: cash-session close reconciles exact net sale/return/void buckets in fils, rejects sub-fils inputs, enforces branch authorization, records exact audit evidence, and cannot close twice.");
} finally {
  await db.close();
}
