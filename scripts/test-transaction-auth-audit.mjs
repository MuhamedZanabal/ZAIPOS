import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

const I = {
  tenantA: "10000000-0000-0000-0000-000000000088",
  tenantB: "10000000-0000-0000-0000-000000000087",
  branchA: "20000000-0000-0000-0000-000000000088",
  branchAOther: "20000000-0000-0000-0000-000000000086",
  branchB: "20000000-0000-0000-0000-000000000087",
  managerA: "30000000-0000-0000-0000-000000000088",
  cashierA: "30000000-0000-0000-0000-000000000089",
  inventoryA: "30000000-0000-0000-0000-000000000086",
  managerB: "30000000-0000-0000-0000-000000000087",
  branchMismatchManager: "30000000-0000-0000-0000-000000000085",
  sessionA: "40000000-0000-0000-0000-000000000088",
  closeSession: "40000000-0000-0000-0000-000000000089",
  centerA: "45000000-0000-0000-0000-000000000088",
  productA: "50000000-0000-0000-0000-000000000088",
};

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function sql(statement) { return psql(["-c", statement], false); }
function scalar(statement) { return psql(["-Atq", "-c", statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ""; }
function asUser(userId, statement) {
  return scalar(`SET request.jwt.claim.sub='${userId}'; ${statement}`);
}
function expectReject(label, userId, statement, pattern = /Forbidden|not authenticated/i) {
  try {
    asUser(userId, statement);
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','manager-a@zaipos.test','{}'),
    ('${I.cashierA}','cashier-a@zaipos.test','{}'),
    ('${I.inventoryA}','inventory-a@zaipos.test','{}'),
    ('${I.managerB}','manager-b@zaipos.test','{}'),
    ('${I.branchMismatchManager}','manager-other-branch@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock) VALUES
    ('${I.tenantA}','Authorization Tenant A','authorization-a','BHD',10,false,false),
    ('${I.tenantB}','Authorization Tenant B','authorization-b','BHD',10,false,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Authorization Branch A','active'),
    ('${I.branchAOther}','${I.tenantA}','Authorization Branch A Other','active'),
    ('${I.branchB}','${I.tenantB}','Authorization Branch B','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}','${I.branchA}','manager'),
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.inventoryA}','${I.tenantA}','${I.branchA}','inventory'),
    ('${I.managerB}','${I.tenantB}','${I.branchB}','manager'),
    ('${I.branchMismatchManager}','${I.tenantA}','${I.branchAOther}','manager')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status)
  VALUES ('${I.centerA}','${I.tenantA}','${I.branchA}','Authorization Center','point_of_sale','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.cash_sessions(id,tenant_id,branch_id,user_id,status) VALUES
    ('${I.sessionA}','${I.tenantA}','${I.branchA}','${I.cashierA}','open'),
    ('${I.closeSession}','${I.tenantA}','${I.branchA}','${I.cashierA}','open')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status)
  VALUES ('${I.productA}','${I.tenantA}','Authorization Product','simple',1.000,0.500,0,'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity)
  VALUES ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.productA}',20.000)
  ON CONFLICT (inventory_center_id,product_id) DO UPDATE SET quantity=20.000;
`);

function checkout(operationId) {
  const items = JSON.stringify([{ product_id: I.productA, quantity: "1.000", discount_fils: 0 }]);
  const payments = JSON.stringify([{ method: "cash", amount_fils: 1000, reference: null }]);
  return `SELECT public.checkout_sale_v2('${I.tenantA}'::uuid,'${I.branchA}'::uuid,'${items}'::jsonb,'${payments}'::jsonb,0::bigint,NULL,NULL::uuid,'pos'::public.sales_channel,0::bigint,NULL,'${operationId}','${I.sessionA}'::uuid);`;
}

// Checkout: cashier is allowed, foreign-tenant manager is not.
const returnSaleId = asUser(I.cashierA, checkout("auth-matrix-return-sale"));
if (!returnSaleId) throw new Error("cashier checkout did not return a sale ID");
expectReject("cross-tenant checkout", I.managerB, checkout("auth-matrix-cross-tenant-checkout"));

const returnItemId = scalar(`SELECT id::text FROM public.sale_items WHERE sale_id='${returnSaleId}'::uuid LIMIT 1;`);
const returnItems = JSON.stringify([{ sale_item_id: returnItemId, quantity: "1.000" }]);
const returnSql = (operationId) => `SELECT public.process_sale_return_v2('${returnSaleId}'::uuid,'${returnItems}'::jsonb,'customer_request','${operationId}','${I.sessionA}'::uuid,'Authorization matrix',NULL);`;

expectReject("cashier return", I.cashierA, returnSql("auth-return-cashier-denied"));
expectReject("cross-tenant return", I.managerB, returnSql("auth-return-cross-tenant"));
expectReject("wrong-branch return", I.branchMismatchManager, returnSql("auth-return-wrong-branch"));
const returnId = asUser(I.managerA, returnSql("auth-return-manager-approved"));
if (!returnId) throw new Error("manager return did not complete");

// Void: manager-only command, with the same branch/session binding.
const voidSaleId = asUser(I.cashierA, checkout("auth-matrix-void-sale"));
const voidSql = (operationId) => `SELECT public.process_sale_void_v2('${voidSaleId}'::uuid,'${operationId}','${I.sessionA}'::uuid,'Authorization matrix');`;
expectReject("cashier void", I.cashierA, voidSql("auth-void-cashier-denied"));
expectReject("cross-tenant void", I.managerB, voidSql("auth-void-cross-tenant"));
expectReject("wrong-branch void", I.branchMismatchManager, voidSql("auth-void-wrong-branch"));
const voidId = asUser(I.managerA, voidSql("auth-void-manager-approved"));
if (!voidId) throw new Error("manager void did not complete");

// Inventory: inventory role is permitted, cashier and foreign tenant are denied.
const batch = JSON.stringify([{ effect_key: "auth-adjustment", product_id: I.productA, movement_type: "adjustment", quantity: "1.000" }]);
const inventorySql = (operationId) => `SELECT public.record_inventory_batch_v2('${I.tenantA}'::uuid,'${I.branchA}'::uuid,'${I.centerA}'::uuid,'${batch}'::jsonb,'${operationId}','Authorization matrix');`;
expectReject("cashier inventory mutation", I.cashierA, inventorySql("auth-inventory-cashier-denied"));
expectReject("cross-tenant inventory mutation", I.managerB, inventorySql("auth-inventory-cross-tenant"));
const inventoryOperationId = asUser(I.inventoryA, inventorySql("auth-inventory-role-approved"));
if (!inventoryOperationId) throw new Error("inventory role command did not complete");

// Cash close: inventory role is denied; cashier responsible for the branch is allowed.
const closeSql = `SELECT (public.close_cash_session('${I.closeSession}'::uuid,0.000,'Authorization matrix',0.000,0.000,0.000)).id;`;
expectReject("inventory cash close", I.inventoryA, closeSql);
const closedId = asUser(I.cashierA, closeSql);
assertEqual("cashier close session", closedId, I.closeSession);

// Direct compensation/history mutation must remain unavailable to authenticated clients.
for (const table of ["sale_return_items", "payment_refunds", "sale_voids", "sale_void_items", "payment_voids", "inventory_operations"]) {
  for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
    assertEqual(`${table} authenticated ${privilege}`, scalar(`SELECT has_table_privilege('authenticated','public.${table}','${privilege}');`), "f");
  }
}
assertEqual(
  "low-level inventory primitive revoked",
  scalar("SELECT has_function_privilege('authenticated','public.apply_inventory_movement(uuid,uuid,uuid,public.movement_type,numeric,text,text,uuid,uuid,uuid)','EXECUTE');"),
  "f",
);

const auditExpectations = [
  ["sale.checkout_committed", returnSaleId],
  ["sale.returned_v2", returnSaleId],
  ["sale.checkout_committed", voidSaleId],
  ["sale.voided_v2", voidSaleId],
  ["inventory.batch_v2", inventoryOperationId],
  ["cash_session.closed", I.closeSession],
];
for (const [action, entityId] of auditExpectations) {
  assertEqual(
    `audit ${action}`,
    scalar(`SELECT count(*)::text FROM public.audit_logs WHERE tenant_id='${I.tenantA}'::uuid AND action='${action}' AND entity_id='${entityId}'::uuid;`),
    "1",
  );
}

for (const action of ["sale.checkout_committed", "sale.returned_v2", "sale.voided_v2", "inventory.batch_v2", "cash_session.closed"]) {
  assertEqual(
    `audit branch metadata ${action}`,
    scalar(`SELECT count(*)::text FROM public.audit_logs WHERE tenant_id='${I.tenantA}'::uuid AND action='${action}' AND metadata->>'branch_id'='${I.branchA}';`),
    action === "sale.checkout_committed" ? "2" : "1",
  );
}

process.stdout.write("Transaction authorization/audit PASS: role, tenant, branch, direct-mutation, and audit invariants hold on the final migrated schema.\n");
