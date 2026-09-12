import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "18000000-0000-0000-0000-000000000211",
  tenantB: "18000000-0000-0000-0000-000000000212",
  managerA: "48000000-0000-0000-0000-000000000211",
  cashierA: "48000000-0000-0000-0000-000000000212",
  managerB: "48000000-0000-0000-0000-000000000213",
  existing: "58000000-0000-0000-0000-000000000211",
  newProduct: "58000000-0000-0000-0000-000000000212",
  rollbackProduct: "58000000-0000-0000-0000-000000000213",
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
  return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertIncludes(label, actual, expected) {
  if (!actual.includes(expected)) throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
}
function expectReject(label, userId, statement, pattern) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}
function q(value) { return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`; }
function call(userId, tenantId, operationId, rows) {
  return asUser(userId, `SELECT public.import_product_catalogue_v1('${tenantId}','${operationId}',${q(rows)})::text`);
}

assertEqual("catalogue import ledger exists", scalar("SELECT to_regclass('public.product_catalogue_import_operations') IS NOT NULL;"), "t");
assertEqual(
  "catalogue import RPC exists",
  scalar("SELECT to_regprocedure('public.import_product_catalogue_v1(uuid,text,jsonb)') IS NOT NULL;"),
  "t",
);

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','catalogue-manager-a@zaipos.test','{}'),
    ('${I.cashierA}','catalogue-cashier-a@zaipos.test','{}'),
    ('${I.managerB}','catalogue-manager-b@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Catalogue Import Tenant A','catalogue-import-a','BHD',10,false),
    ('${I.tenantB}','Catalogue Import Tenant B','catalogue-import-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}',NULL,'manager'),
    ('${I.cashierA}','${I.tenantA}',NULL,'cashier'),
    ('${I.managerB}','${I.tenantB}',NULL,'manager')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.products(id,tenant_id,name,product_type,sku,price,cost,tax_rate,status,barcode) VALUES
    ('${I.existing}','${I.tenantA}','Old Cola','simple','CAT-OLD',1.000,0.500,10,'active',NULL)
  ON CONFLICT (id) DO NOTHING;
`);

const validRows = [
  {
    id: I.existing,
    name: "Updated Cola",
    sku: "CAT-OLD",
    selling_amount_fils: 1250,
    cost_amount_fils: 675,
    tax_rate: 10,
    min_stock: 2.5,
    status: "active",
    unit_code: "unit",
    product_type: "simple",
    barcodes: [{ barcode: "6291000000211", barcode_type: "legacy", is_primary: true }],
  },
  {
    id: I.newProduct,
    name: "Imported Water",
    sku: "CAT-NEW",
    selling_amount_fils: 375,
    cost_amount_fils: 225,
    tax_rate: 10,
    min_stock: 3,
    status: "active",
    unit_code: "unit",
    product_type: "simple",
    barcodes: [{ barcode: "6291000000212", barcode_type: "legacy", is_primary: true }],
  },
];

expectReject(
  "cashier cannot import catalogue",
  I.cashierA,
  `SELECT public.import_product_catalogue_v1('${I.tenantA}','catalogue-op-cashier',${q(validRows)})`,
  /forbidden|permission|manager/i,
);
expectReject(
  "cross-tenant manager cannot import catalogue",
  I.managerB,
  `SELECT public.import_product_catalogue_v1('${I.tenantA}','catalogue-op-cross-tenant',${q(validRows)})`,
  /forbidden|permission|manager/i,
);

const result = JSON.parse(call(I.managerA, I.tenantA, "catalogue-op-success-0001", validRows));
assertEqual("created count", String(result.created), "1");
assertEqual("updated count", String(result.updated), "1");
assertEqual("processed count", String(result.processed), "2");
assertEqual("existing exact selling fils", scalar(`SELECT price_fils::text FROM public.products WHERE id='${I.existing}'`), "1250");
assertEqual("existing exact cost fils", scalar(`SELECT cost_fils::text FROM public.products WHERE id='${I.existing}'`), "675");
assertEqual("new exact selling fils", scalar(`SELECT price_fils::text FROM public.products WHERE id='${I.newProduct}'`), "375");
assertEqual("new exact cost fils", scalar(`SELECT cost_fils::text FROM public.products WHERE id='${I.newProduct}'`), "225");
assertEqual("existing barcode replaced", scalar(`SELECT barcode FROM public.product_barcodes WHERE tenant_id='${I.tenantA}' AND product_id='${I.existing}' AND is_primary`), "6291000000211");
assertEqual("new barcode installed", scalar(`SELECT barcode FROM public.product_barcodes WHERE tenant_id='${I.tenantA}' AND product_id='${I.newProduct}' AND is_primary`), "6291000000212");
assertEqual("financial history recorded", scalar(`SELECT count(*)::text FROM public.product_prices WHERE tenant_id='${I.tenantA}' AND product_id='${I.existing}' AND effective_to IS NULL AND branch_id IS NULL AND channel IS NULL`), "2");
assertEqual("audit evidence exists", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE tenant_id='${I.tenantA}' AND action='catalogue.products_imported' AND metadata->>'operation_id'='catalogue-op-success-0001'`), "1");

const replay = JSON.parse(call(I.managerA, I.tenantA, "catalogue-op-success-0001", validRows));
assertEqual("idempotent replay result", JSON.stringify(replay), JSON.stringify(result));
assertEqual("one operation ledger row", scalar(`SELECT count(*)::text FROM public.product_catalogue_import_operations WHERE tenant_id='${I.tenantA}' AND operation_id='catalogue-op-success-0001'`), "1");
expectReject(
  "operation id is payload-bound",
  I.managerA,
  `SELECT public.import_product_catalogue_v1('${I.tenantA}','catalogue-op-success-0001',${q([{ ...validRows[0], name: "Different intent" }])})`,
  /operation.*different|different.*input|payload/i,
);

const rollbackRows = [
  {
    id: I.rollbackProduct,
    name: "Must Roll Back",
    sku: "CAT-ROLLBACK",
    selling_amount_fils: 500,
    cost_amount_fils: 300,
    tax_rate: 10,
    min_stock: 0,
    status: "active",
    unit_code: "unit",
    product_type: "simple",
    barcodes: [{ barcode: "6291000000299", barcode_type: "legacy", is_primary: true }],
  },
  {
    id: crypto.randomUUID(),
    name: "Conflicting Barcode",
    sku: "CAT-CONFLICT",
    selling_amount_fils: 600,
    cost_amount_fils: 350,
    tax_rate: 10,
    min_stock: 0,
    status: "active",
    unit_code: "unit",
    product_type: "simple",
    barcodes: [{ barcode: "6291000000212", barcode_type: "legacy", is_primary: true }],
  },
];
expectReject(
  "whole file rolls back on later barcode conflict",
  I.managerA,
  `SELECT public.import_product_catalogue_v1('${I.tenantA}','catalogue-op-rollback-0001',${q(rollbackRows)})`,
  /barcode|conflict|duplicate/i,
);
assertEqual("earlier row did not partially commit", scalar(`SELECT count(*)::text FROM public.products WHERE id='${I.rollbackProduct}'`), "0");
assertEqual("failed operation not falsely completed", scalar(`SELECT count(*)::text FROM public.product_catalogue_import_operations WHERE tenant_id='${I.tenantA}' AND operation_id='catalogue-op-rollback-0001'`), "0");

expectReject(
  "duplicate SKU inside one payload is rejected before mutation",
  I.managerA,
  `SELECT public.import_product_catalogue_v1('${I.tenantA}','catalogue-op-duplicate-sku',${q([
    { ...validRows[0], id: crypto.randomUUID(), sku: "DUP-IN-FILE", barcodes: [] },
    { ...validRows[1], id: crypto.randomUUID(), sku: "DUP-IN-FILE", barcodes: [] },
  ])})`,
  /duplicate.*sku|sku.*duplicate/i,
);

console.log("Atomic catalogue import contract passed.");
