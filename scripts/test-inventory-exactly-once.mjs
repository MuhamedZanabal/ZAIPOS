import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("../supabase/migrations/20260905110000_inventory_exactly_once.sql", import.meta.url);
let migration;
try {
  migration = await readFile(migrationUrl, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error("P0 inventory exactly-once migration missing: inventory v2 commands are not implemented");
  }
  throw error;
}

const db = new PGlite();

const IDS = {
  tenant: "10000000-0000-0000-0000-000000000001",
  branch: "20000000-0000-0000-0000-000000000001",
  manager: "30000000-0000-0000-0000-000000000001",
  cashier: "30000000-0000-0000-0000-000000000002",
  centerA: "40000000-0000-0000-0000-000000000001",
  centerB: "40000000-0000-0000-0000-000000000002",
  productA: "50000000-0000-0000-0000-000000000001",
  productB: "50000000-0000-0000-0000-000000000002",
  ingredient: "50000000-0000-0000-0000-000000000003",
  productionOrder: "60000000-0000-0000-0000-000000000001",
  purchaseOrder: "70000000-0000-0000-0000-000000000001",
  tableOrder: "80000000-0000-0000-0000-000000000001",
  tableItem: "90000000-0000-0000-0000-000000000001",
};

async function asUser(userId) {
  await db.exec(`SET request.jwt.claim.sub = '${userId}'`);
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
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT 'authenticated'::text
    $$;

    CREATE TYPE public.app_role AS ENUM ('owner','admin','manager','cashier','kitchen','inventory','staff','waiter');
    CREATE TYPE public.product_type AS ENUM ('simple','composite','production','combo','ingredient','modifier');
    CREATE TYPE public.movement_type AS ENUM ('purchase','sale','production','waste','adjustment','transfer','return','consumption');
    CREATE TYPE public.production_status AS ENUM ('draft','in_progress','completed','cancelled');
    CREATE TYPE public.table_item_status AS ENUM ('pending','dispatched','cancelled');
    CREATE TYPE public.entity_status AS ENUM ('active','inactive');

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
    CREATE OR REPLACE FUNCTION public.has_any_role(
      _user_id uuid, _tenant_id uuid, _roles public.app_role[]
    ) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = _user_id AND tenant_id = _tenant_id AND role = ANY(_roles)
      )
    $$;
    CREATE OR REPLACE FUNCTION public.is_tenant_member(_user_id uuid, _tenant_id uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND tenant_id = _tenant_id)
    $$;

    CREATE TABLE public.products (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      name text NOT NULL,
      product_type public.product_type NOT NULL DEFAULT 'simple',
      status public.entity_status NOT NULL DEFAULT 'active'
    );
    CREATE TABLE public.product_components (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      parent_product_id uuid NOT NULL REFERENCES public.products(id),
      component_product_id uuid NOT NULL REFERENCES public.products(id),
      quantity numeric(12,3) NOT NULL,
      waste_pct numeric(5,2) NOT NULL DEFAULT 0
    );
    CREATE TABLE public.inventory_centers (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      name text NOT NULL,
      is_default boolean NOT NULL DEFAULT false,
      status public.entity_status NOT NULL DEFAULT 'active'
    );
    CREATE TABLE public.inventory_stocks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      inventory_center_id uuid REFERENCES public.inventory_centers(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      quantity numeric(12,3) NOT NULL DEFAULT 0,
      UNIQUE(inventory_center_id, product_id)
    );
    CREATE TABLE public.inventory_movements (
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

    CREATE OR REPLACE FUNCTION public.apply_inventory_movement(
      _tenant_id uuid, _branch_id uuid, _product_id uuid,
      _movement_type public.movement_type, _quantity numeric, _reason text,
      _reference_type text, _reference_id uuid, _user_id uuid,
      _inventory_center_id uuid DEFAULT NULL
    ) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE _signed numeric; _movement_id uuid; BEGIN
      IF COALESCE(_quantity, 0) <= 0 THEN RAISE EXCEPTION 'Invalid quantity'; END IF;
      _signed := CASE
        WHEN _movement_type IN ('purchase','production','return','adjustment') THEN _quantity
        ELSE -_quantity
      END;
      INSERT INTO public.inventory_stocks (tenant_id, branch_id, inventory_center_id, product_id, quantity)
      VALUES (_tenant_id, _branch_id, _inventory_center_id, _product_id, _signed)
      ON CONFLICT (inventory_center_id, product_id)
      DO UPDATE SET quantity = public.inventory_stocks.quantity + EXCLUDED.quantity;
      INSERT INTO public.inventory_movements (
        tenant_id, branch_id, inventory_center_id, product_id, movement_type,
        quantity, reason, reference_type, reference_id, user_id
      ) VALUES (
        _tenant_id, _branch_id, _inventory_center_id, _product_id, _movement_type,
        _quantity, _reason, _reference_type, _reference_id, _user_id
      ) RETURNING id INTO _movement_id;
      RETURN _movement_id;
    END; $$;
    GRANT EXECUTE ON FUNCTION public.apply_inventory_movement(uuid,uuid,uuid,public.movement_type,numeric,text,text,uuid,uuid,uuid) TO authenticated;

    CREATE TABLE public.purchase_orders (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      status text NOT NULL DEFAULT 'draft',
      received_at timestamptz
    );
    CREATE TABLE public.purchase_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES public.purchase_orders(id),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      product_id uuid REFERENCES public.products(id),
      product_name text NOT NULL,
      quantity numeric(12,3) NOT NULL,
      cost_price numeric(18,3) NOT NULL DEFAULT 0,
      line_total numeric(18,3) NOT NULL DEFAULT 0
    );

    CREATE TABLE public.production_orders (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      user_id uuid REFERENCES auth.users(id),
      planned_quantity numeric(12,3) NOT NULL,
      produced_quantity numeric(12,3),
      waste_quantity numeric(12,3) DEFAULT 0,
      status public.production_status NOT NULL DEFAULT 'draft',
      completed_at timestamptz
    );
    CREATE TABLE public.production_consumptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      order_id uuid NOT NULL REFERENCES public.production_orders(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      quantity numeric(12,3) NOT NULL
    );

    CREATE TABLE public.table_orders (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id)
    );
    CREATE TABLE public.table_order_items (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      order_id uuid NOT NULL REFERENCES public.table_orders(id),
      product_id uuid NOT NULL REFERENCES public.products(id),
      product_type public.product_type NOT NULL,
      quantity numeric(12,3) NOT NULL,
      status public.table_item_status NOT NULL DEFAULT 'pending',
      dispatched_at timestamptz,
      dispatched_by uuid
    );
    CREATE OR REPLACE FUNCTION public.dispatch_table_item(_item_id uuid)
    RETURNS public.table_order_items LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE _it public.table_order_items; _o public.table_orders; BEGIN
      SELECT * INTO _it FROM public.table_order_items WHERE id = _item_id;
      IF _it.status = 'dispatched' THEN RETURN _it; END IF;
      SELECT * INTO _o FROM public.table_orders WHERE id = _it.order_id;
      PERFORM public.apply_inventory_movement(_o.tenant_id,_o.branch_id,_it.product_id,'sale',_it.quantity,'table','table_order',_o.id,auth.uid(),NULL);
      UPDATE public.table_order_items SET status='dispatched' WHERE id=_item_id RETURNING * INTO _it;
      RETURN _it;
    END; $$;
    CREATE OR REPLACE FUNCTION public.undispatch_table_item(_item_id uuid)
    RETURNS public.table_order_items LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE _it public.table_order_items; _o public.table_orders; BEGIN
      SELECT * INTO _it FROM public.table_order_items WHERE id = _item_id;
      IF _it.status <> 'dispatched' THEN RETURN _it; END IF;
      SELECT * INTO _o FROM public.table_orders WHERE id = _it.order_id;
      PERFORM public.apply_inventory_movement(_o.tenant_id,_o.branch_id,_it.product_id,'return',_it.quantity,'table','table_order',_o.id,auth.uid(),NULL);
      UPDATE public.table_order_items SET status='pending' WHERE id=_item_id RETURNING * INTO _it;
      RETURN _it;
    END; $$;
  `);

  await db.exec(migration);

  await db.exec(`
    INSERT INTO auth.users(id) VALUES ('${IDS.manager}'),('${IDS.cashier}');
    INSERT INTO public.tenants(id) VALUES ('${IDS.tenant}');
    INSERT INTO public.branches(id,tenant_id) VALUES ('${IDS.branch}','${IDS.tenant}');
    INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
      ('${IDS.manager}','${IDS.tenant}','${IDS.branch}','manager'),
      ('${IDS.cashier}','${IDS.tenant}','${IDS.branch}','cashier');
    INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,is_default) VALUES
      ('${IDS.centerA}','${IDS.tenant}','${IDS.branch}','Main',true),
      ('${IDS.centerB}','${IDS.tenant}','${IDS.branch}','Back',false);
    INSERT INTO public.products(id,tenant_id,name,product_type) VALUES
      ('${IDS.productA}','${IDS.tenant}','Product A','simple'),
      ('${IDS.productB}','${IDS.tenant}','Product B','production'),
      ('${IDS.ingredient}','${IDS.tenant}','Ingredient','ingredient');
    INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES
      ('${IDS.tenant}','${IDS.branch}','${IDS.centerA}','${IDS.productA}',10),
      ('${IDS.tenant}','${IDS.branch}','${IDS.centerA}','${IDS.productB}',0),
      ('${IDS.tenant}','${IDS.branch}','${IDS.centerA}','${IDS.ingredient}',20),
      ('${IDS.tenant}','${IDS.branch}','${IDS.centerB}','${IDS.productA}',0);
    INSERT INTO public.product_components(tenant_id,parent_product_id,component_product_id,quantity,waste_pct)
    VALUES ('${IDS.tenant}','${IDS.productB}','${IDS.ingredient}',2,0);
    INSERT INTO public.production_orders(id,tenant_id,branch_id,product_id,planned_quantity)
    VALUES ('${IDS.productionOrder}','${IDS.tenant}','${IDS.branch}','${IDS.productB}',3);
    INSERT INTO public.purchase_orders(id,tenant_id,branch_id,status)
    VALUES ('${IDS.purchaseOrder}','${IDS.tenant}','${IDS.branch}','draft');
    INSERT INTO public.purchase_order_items(order_id,tenant_id,product_id,product_name,quantity)
    VALUES
      ('${IDS.purchaseOrder}','${IDS.tenant}','${IDS.productA}','Product A',2),
      ('${IDS.purchaseOrder}','${IDS.tenant}','${IDS.ingredient}','Ingredient',3);
    INSERT INTO public.table_orders(id,tenant_id,branch_id)
    VALUES ('${IDS.tableOrder}','${IDS.tenant}','${IDS.branch}');
    INSERT INTO public.table_order_items(id,tenant_id,order_id,product_id,product_type,quantity,status)
    VALUES ('${IDS.tableItem}','${IDS.tenant}','${IDS.tableOrder}','${IDS.productA}','simple',1,'pending');
  `);

  await asUser(IDS.manager);

  const batchPayload = JSON.stringify([
    { product_id: IDS.productA, movement_type: 'purchase', quantity: '1.250', effect_key: 'line-a' },
    { product_id: IDS.ingredient, movement_type: 'purchase', quantity: '2.000', effect_key: 'line-b' },
  ]);
  const batchSql = `SELECT public.record_inventory_batch_v2(
    '${IDS.tenant}'::uuid,'${IDS.branch}'::uuid,'${IDS.centerA}'::uuid,
    '${batchPayload}'::jsonb,'inventory-batch-0001','Receiving test'
  ) AS operation_id`;
  const firstBatch = await one(batchSql);
  const replayBatch = await one(batchSql);
  if (firstBatch.operation_id !== replayBatch.operation_id) throw new Error('batch replay did not return original operation');
  const batchState = await one(`SELECT
    (SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${IDS.centerA}' AND product_id='${IDS.productA}') AS a,
    (SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${IDS.centerA}' AND product_id='${IDS.ingredient}') AS b,
    (SELECT count(*)::int FROM public.inventory_movements WHERE reference_type='inventory_operation' AND reference_id='${firstBatch.operation_id}') AS movements`);
  if (Number(batchState.a) !== 11.25 || Number(batchState.b) !== 22 || batchState.movements !== 2) {
    throw new Error(`batch replay duplicated or dropped effects: ${JSON.stringify(batchState)}`);
  }
  await expectReject(
    'batch operation payload mismatch',
    `SELECT public.record_inventory_batch_v2('${IDS.tenant}','${IDS.branch}','${IDS.centerA}',
      '[{"product_id":"${IDS.productA}","movement_type":"purchase","quantity":"9.000","effect_key":"line-a"}]'::jsonb,
      'inventory-batch-0001','Receiving test')`,
    'different inventory request',
  );

  const transferSql = `SELECT public.transfer_inventory_v2(
    '${IDS.tenant}','${IDS.branch}','${IDS.productA}','${IDS.centerA}','${IDS.centerB}',
    2.000,'Move stock','inventory-transfer-0001') AS operation_id`;
  const transfer1 = await one(transferSql);
  const transfer2 = await one(transferSql);
  if (transfer1.operation_id !== transfer2.operation_id) throw new Error('transfer replay did not return original operation');
  const transferState = await one(`SELECT
    (SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${IDS.centerA}' AND product_id='${IDS.productA}') AS source,
    (SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${IDS.centerB}' AND product_id='${IDS.productA}') AS destination`);
  if (Number(transferState.source) !== 9.25 || Number(transferState.destination) !== 2) {
    throw new Error(`transfer replay duplicated effects: ${JSON.stringify(transferState)}`);
  }

  const receiveSql = `SELECT public.receive_purchase_order_v2(
    '${IDS.purchaseOrder}','${IDS.centerA}','inventory-po-0001') AS operation_id`;
  const po1 = await one(receiveSql);
  const po2 = await one(receiveSql);
  if (po1.operation_id !== po2.operation_id) throw new Error('purchase-order replay did not return original operation');
  const poState = await one(`SELECT
    (SELECT status FROM public.purchase_orders WHERE id='${IDS.purchaseOrder}') AS status,
    (SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${IDS.centerA}' AND product_id='${IDS.productA}') AS a,
    (SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${IDS.centerA}' AND product_id='${IDS.ingredient}') AS ingredient`);
  if (poState.status !== 'received' || Number(poState.a) !== 11.25 || Number(poState.ingredient) !== 25) {
    throw new Error(`purchase receive was not atomic/idempotent: ${JSON.stringify(poState)}`);
  }

  const productionSql = `SELECT public.complete_production_order_v2(
    '${IDS.productionOrder}',3.000,0,'inventory-production-0001') AS operation_id`;
  const prod1 = await one(productionSql);
  const prod2 = await one(productionSql);
  if (prod1.operation_id !== prod2.operation_id) throw new Error('production replay did not return original operation');
  const productionState = await one(`SELECT
    (SELECT status::text FROM public.production_orders WHERE id='${IDS.productionOrder}') AS status,
    (SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${IDS.centerA}' AND product_id='${IDS.productB}') AS output,
    (SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${IDS.centerA}' AND product_id='${IDS.ingredient}') AS ingredient,
    (SELECT count(*)::int FROM public.production_consumptions WHERE order_id='${IDS.productionOrder}') AS consumptions`);
  if (productionState.status !== 'completed' || Number(productionState.output) !== 3 || Number(productionState.ingredient) !== 19 || productionState.consumptions !== 1) {
    throw new Error(`production replay duplicated effects: ${JSON.stringify(productionState)}`);
  }

  const directPrivilege = await one(`SELECT has_function_privilege(
    'authenticated',
    'public.apply_inventory_movement(uuid,uuid,uuid,public.movement_type,numeric,text,text,uuid,uuid,uuid)',
    'EXECUTE'
  ) AS allowed`);
  if (directPrivilege.allowed) throw new Error('authenticated clients can still execute the low-level inventory primitive directly');

  const dispatchDefinition = await one(`SELECT pg_get_functiondef('public.dispatch_table_item(uuid)'::regprocedure) AS body`);
  const undispatchDefinition = await one(`SELECT pg_get_functiondef('public.undispatch_table_item(uuid)'::regprocedure) AS body`);
  if (!/FOR UPDATE/i.test(dispatchDefinition.body) || !/FOR UPDATE/i.test(undispatchDefinition.body)) {
    throw new Error('table dispatch/undispatch must lock the item row before stock effects');
  }

  console.log('PASS: inventory v2 commands provide atomic replay-safe batch receiving, purchase receiving, transfer and production effects; low-level inventory mutation is command-owned; table dispatch transitions are row-locked.');
} finally {
  await db.close();
}
