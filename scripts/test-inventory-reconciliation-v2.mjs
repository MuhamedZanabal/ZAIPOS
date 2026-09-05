import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("../supabase/migrations/20260905110000_inventory_exactly_once.sql", import.meta.url),
  "utf8",
);

const marker = "CREATE OR REPLACE FUNCTION public.reconcile_inventory_levels_v2";
const start = migration.indexOf(marker);
if (start < 0) {
  throw new Error("P0 inventory reconciliation missing: reconcile_inventory_levels_v2 is not implemented");
}
const bodyEnd = migration.indexOf("\n$$;", start);
if (bodyEnd < 0) throw new Error("Could not extract reconcile_inventory_levels_v2 from migration");
const reconcileSql = migration.slice(start, bodyEnd + 4);

const db = new PGlite();
const IDS = {
  tenant: "10000000-0000-0000-0000-000000000001",
  branch: "20000000-0000-0000-0000-000000000001",
  manager: "30000000-0000-0000-0000-000000000001",
  cashier: "30000000-0000-0000-0000-000000000002",
  center: "40000000-0000-0000-0000-000000000001",
  productA: "50000000-0000-0000-0000-000000000001",
  productB: "50000000-0000-0000-0000-000000000002",
};

async function asUser(id) {
  await db.exec(`SET request.jwt.claim.sub = '${id}'`);
}
async function one(sql) {
  const result = await db.query(sql);
  return result.rows[0];
}
async function expectReject(label, sql, expected) {
  try {
    await db.query(sql);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.toLowerCase().includes(expected.toLowerCase())) {
      throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${message}`);
    }
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

try {
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    CREATE TYPE public.app_role AS ENUM ('owner','admin','manager','cashier','kitchen','inventory','staff','waiter');
    CREATE TYPE public.entity_status AS ENUM ('active','inactive');
    CREATE TYPE public.movement_type AS ENUM ('purchase','sale','production','waste','adjustment','transfer','return','consumption');

    CREATE TABLE public.tenants(id uuid PRIMARY KEY);
    CREATE TABLE public.branches(
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      status public.entity_status NOT NULL DEFAULT 'active'
    );
    CREATE TABLE public.user_roles(
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
        WHERE user_id=_user_id AND tenant_id=_tenant_id AND role=ANY(_roles)
          AND (branch_id IS NULL OR branch_id=_branch_id)
      )
    $$;

    CREATE TABLE public.products(
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      name text NOT NULL,
      status public.entity_status NOT NULL DEFAULT 'active'
    );
    CREATE TABLE public.inventory_centers(
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      name text NOT NULL,
      status public.entity_status NOT NULL DEFAULT 'active'
    );
    CREATE TABLE public.inventory_stocks(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      inventory_center_id uuid NOT NULL REFERENCES public.inventory_centers(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      quantity numeric(12,3) NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(inventory_center_id, product_id)
    );
    CREATE TABLE public.inventory_movements(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      inventory_center_id uuid REFERENCES public.inventory_centers(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      movement_type public.movement_type NOT NULL,
      quantity numeric(12,3) NOT NULL,
      reason text,
      reference_type text,
      reference_id uuid,
      user_id uuid REFERENCES auth.users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.inventory_operations(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      operation_type text NOT NULL,
      client_mutation_id text NOT NULL,
      request_payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'processing',
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      UNIQUE(tenant_id, client_mutation_id)
    );
    CREATE OR REPLACE FUNCTION public.claim_inventory_operation_v2(
      _tenant_id uuid, _branch_id uuid, _operation_type text,
      _client_mutation_id text, _request_payload jsonb
    ) RETURNS TABLE(operation_id uuid,is_replay boolean)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
    DECLARE _new_id uuid; _existing public.inventory_operations; BEGIN
      INSERT INTO public.inventory_operations(tenant_id,branch_id,operation_type,client_mutation_id,request_payload)
      VALUES(_tenant_id,_branch_id,_operation_type,_client_mutation_id,_request_payload)
      ON CONFLICT(tenant_id,client_mutation_id) DO NOTHING RETURNING id INTO _new_id;
      IF _new_id IS NOT NULL THEN operation_id:=_new_id; is_replay:=false; RETURN NEXT; RETURN; END IF;
      SELECT * INTO _existing FROM public.inventory_operations
      WHERE tenant_id=_tenant_id AND client_mutation_id=_client_mutation_id FOR UPDATE;
      IF _existing.branch_id IS DISTINCT FROM _branch_id
        OR _existing.operation_type IS DISTINCT FROM _operation_type
        OR _existing.request_payload IS DISTINCT FROM _request_payload THEN
        RAISE EXCEPTION 'Client mutation ID was already used for a different inventory request';
      END IF;
      IF _existing.status='completed' THEN operation_id:=_existing.id; is_replay:=true; RETURN NEXT; RETURN; END IF;
      RAISE EXCEPTION 'Inventory operation is already processing';
    END; $$;
  `);

  await db.exec(reconcileSql);
  await db.exec(`
    INSERT INTO auth.users(id) VALUES('${IDS.manager}'),('${IDS.cashier}');
    INSERT INTO public.tenants(id) VALUES('${IDS.tenant}');
    INSERT INTO public.branches(id,tenant_id) VALUES('${IDS.branch}','${IDS.tenant}');
    INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
      ('${IDS.manager}','${IDS.tenant}','${IDS.branch}','manager'),
      ('${IDS.cashier}','${IDS.tenant}','${IDS.branch}','cashier');
    INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name)
      VALUES('${IDS.center}','${IDS.tenant}','${IDS.branch}','Main');
    INSERT INTO public.products(id,tenant_id,name) VALUES
      ('${IDS.productA}','${IDS.tenant}','A'),('${IDS.productB}','${IDS.tenant}','B');
    INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES
      ('${IDS.tenant}','${IDS.branch}','${IDS.center}','${IDS.productA}',10),
      ('${IDS.tenant}','${IDS.branch}','${IDS.center}','${IDS.productB}',5);
  `);

  await asUser(IDS.manager);
  const targets = JSON.stringify([
    { product_id: IDS.productA, target_quantity: '7.500', effect_key: 'sku-a' },
    { product_id: IDS.productB, target_quantity: '8.250', effect_key: 'sku-b' },
  ]);
  const reconcile = `SELECT public.reconcile_inventory_levels_v2(
    '${IDS.tenant}','${IDS.branch}','${IDS.center}','${targets}'::jsonb,
    'inventory-reconcile-0001','Physical count import') AS operation_id`;
  const first = await one(reconcile);
  const replay = await one(reconcile);
  if (first.operation_id !== replay.operation_id) throw new Error('reconciliation replay returned a different operation');

  const state = await one(`SELECT
    (SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${IDS.center}' AND product_id='${IDS.productA}') AS a,
    (SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${IDS.center}' AND product_id='${IDS.productB}') AS b,
    (SELECT quantity FROM public.inventory_movements WHERE reference_id='${first.operation_id}' AND product_id='${IDS.productA}') AS delta_a,
    (SELECT quantity FROM public.inventory_movements WHERE reference_id='${first.operation_id}' AND product_id='${IDS.productB}') AS delta_b,
    (SELECT count(*)::int FROM public.inventory_movements WHERE reference_id='${first.operation_id}') AS movement_count`);
  if (Number(state.a) !== 7.5 || Number(state.b) !== 8.25 || Number(state.delta_a) !== -2.5 || Number(state.delta_b) !== 3.25 || state.movement_count !== 2) {
    throw new Error(`reconciliation did not persist exact target levels once: ${JSON.stringify(state)}`);
  }

  await expectReject(
    'reconciliation payload mismatch',
    `SELECT public.reconcile_inventory_levels_v2('${IDS.tenant}','${IDS.branch}','${IDS.center}',
      '[{"product_id":"${IDS.productA}","target_quantity":"9.000","effect_key":"sku-a"}]'::jsonb,
      'inventory-reconcile-0001','Physical count import')`,
    'different inventory request',
  );

  await db.exec(`UPDATE public.inventory_stocks SET quantity=9 WHERE inventory_center_id='${IDS.center}' AND product_id='${IDS.productA}'`);
  const secondTargets = JSON.stringify([{ product_id: IDS.productA, target_quantity: '7.500', effect_key: 'sku-a' }]);
  await one(`SELECT public.reconcile_inventory_levels_v2(
    '${IDS.tenant}','${IDS.branch}','${IDS.center}','${secondTargets}'::jsonb,
    'inventory-reconcile-0002','Second physical count') AS operation_id`);
  const authoritative = await one(`SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${IDS.center}' AND product_id='${IDS.productA}'`);
  if (Number(authoritative.quantity) !== 7.5) throw new Error('reconciliation did not compute the correction from server-current stock');

  await expectReject(
    'negative target',
    `SELECT public.reconcile_inventory_levels_v2('${IDS.tenant}','${IDS.branch}','${IDS.center}',
      '[{"product_id":"${IDS.productA}","target_quantity":"-1.000","effect_key":"bad"}]'::jsonb,
      'inventory-reconcile-0003','Bad target')`,
    'non-negative',
  );

  await asUser(IDS.cashier);
  await expectReject(
    'cashier reconciliation',
    `SELECT public.reconcile_inventory_levels_v2('${IDS.tenant}','${IDS.branch}','${IDS.center}',
      '[{"product_id":"${IDS.productA}","target_quantity":"7.500","effect_key":"sku-a"}]'::jsonb,
      'inventory-reconcile-0004','Forbidden')`,
    'forbidden',
  );

  console.log('PASS: physical-count reconciliation is server-authoritative, atomic, replay-safe, supports increases/decreases, and records signed adjustment evidence.');
} finally {
  await db.close();
}
