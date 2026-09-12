import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenant: "91000000-0000-0000-0000-000000000001",
  branch: "92000000-0000-0000-0000-000000000001",
  manager: "93000000-0000-0000-0000-000000000001",
  center: "94000000-0000-0000-0000-000000000001",
  product: "95000000-0000-0000-0000-000000000001",
  legacyProduct: "95000000-0000-0000-0000-000000000002",
};

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}
function sql(statement) { return psql(["-c", statement], false); }
function scalar(statement) { return psql(["-Atq", "-c", statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ""; }
function asUser(statement) {
  return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${I.manager}'; ${statement}; COMMIT;`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectReject(label, fn, pattern) {
  try { fn(); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

for (const signature of [
  "public.configure_product_lot_tracking_v1(uuid,uuid,uuid,uuid,boolean,text)",
  "public.receive_inventory_lot_v1(uuid,uuid,uuid,uuid,text,date,date,numeric,text,text)",
  "public.allocate_inventory_lots_fefo_v1(uuid,uuid,uuid,uuid,numeric,uuid,uuid)",
]) {
  assertEqual(`function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.manager}','lot-manager@zaipos.test','{}') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenant}','Lot Runtime Tenant','lot-runtime-tenant','BHD',10,false) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branch}','${I.tenant}','Lot Runtime Branch','active') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES
    ('${I.center}','${I.tenant}','${I.branch}','Lot Runtime Center','warehouse','active') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.manager}','${I.tenant}','${I.branch}','manager') ON CONFLICT DO NOTHING;
  INSERT INTO public.products(id,tenant_id,name,product_type,sku,price,cost,tax_rate,status,barcode) VALUES
    ('${I.product}','${I.tenant}','Expiry Milk','simple','LOT-MILK',1.000,0.500,10,'active',NULL),
    ('${I.legacyProduct}','${I.tenant}','Legacy Milk','simple','LEGACY-MILK',1.000,0.500,10,'active',NULL)
  ON CONFLICT (id) DO NOTHING;
`);

const configOperation = asUser(`SELECT public.configure_product_lot_tracking_v1('${I.tenant}','${I.branch}','${I.center}','${I.product}',true,'lot-enable-0001');`);
assertEqual("lot tracking enabled", scalar(`SELECT lot_tracking_enabled::text FROM public.product_inventory_controls WHERE inventory_center_id='${I.center}' AND product_id='${I.product}';`), "true");
assertEqual("configuration operation completed", scalar(`SELECT status FROM public.inventory_operations WHERE id='${configOperation}';`), "completed");

const receiptA = asUser(`SELECT public.receive_inventory_lot_v1('${I.tenant}','${I.branch}','${I.center}','${I.product}','BATCH-EARLY','2026-09-01','2026-10-01',5.000,'lot-receipt-0001','runtime test');`);
const replayA = asUser(`SELECT public.receive_inventory_lot_v1('${I.tenant}','${I.branch}','${I.center}','${I.product}','BATCH-EARLY','2026-09-01','2026-10-01',5.000,'lot-receipt-0001','runtime test');`);
assertEqual("receipt replay returns same operation", replayA, receiptA);
assertEqual("replay does not duplicate lot", scalar(`SELECT count(*)::text FROM public.inventory_lots WHERE source_operation_id='${receiptA}';`), "1");
expectReject("mutation payload binding", () => asUser(`SELECT public.receive_inventory_lot_v1('${I.tenant}','${I.branch}','${I.center}','${I.product}','BATCH-EARLY','2026-09-01','2026-10-01',4.000,'lot-receipt-0001','runtime test');`), /different inventory request/i);

asUser(`SELECT public.receive_inventory_lot_v1('${I.tenant}','${I.branch}','${I.center}','${I.product}','BATCH-LATE','2026-09-01','2026-11-01',5.000,'lot-receipt-0002','runtime test');`);
assertEqual("aggregate receipt stock", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.product}';`), "10.000");
assertEqual("lot receipt stock", scalar(`SELECT sum(quantity_remaining)::text FROM public.inventory_lots WHERE inventory_center_id='${I.center}' AND product_id='${I.product}';`), "10.000");

sql(`SELECT public.apply_inventory_movement('${I.tenant}','${I.branch}','${I.product}','sale'::public.movement_type,6.000,'FEFO runtime sale','runtime_test','${receiptA}','${I.manager}','${I.center}');`);
assertEqual("aggregate sale stock", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.product}';`), "4.000");
assertEqual("FEFO consumed earliest lot", scalar(`SELECT quantity_remaining::text FROM public.inventory_lots WHERE inventory_center_id='${I.center}' AND product_id='${I.product}' AND batch_number='BATCH-EARLY';`), "0.000");
assertEqual("FEFO continued to later lot", scalar(`SELECT quantity_remaining::text FROM public.inventory_lots WHERE inventory_center_id='${I.center}' AND product_id='${I.product}' AND batch_number='BATCH-LATE';`), "4.000");

asUser(`SELECT public.receive_inventory_lot_v1('${I.tenant}','${I.branch}','${I.center}','${I.product}','BATCH-EXPIRED','2025-01-01','2025-02-01',3.000,'lot-receipt-0003','expired physical stock');`);
assertEqual("expired physical stock remains in aggregate", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.product}';`), "7.000");
expectReject("expired lot is not sellable", () => sql(`SELECT public.apply_inventory_movement('${I.tenant}','${I.branch}','${I.product}','sale'::public.movement_type,5.000,'must rollback','runtime_test','${receiptA}','${I.manager}','${I.center}');`), /insufficient unexpired non-quarantined lot stock/i);
assertEqual("failed allocation rolls back aggregate stock", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.product}';`), "7.000");

expectReject("authenticated direct lot mutation", () => asUser(`UPDATE public.inventory_lots SET quantity_remaining=0 WHERE inventory_center_id='${I.center}' AND product_id='${I.product}'; SELECT 'unexpected';`), /permission denied/i);

sql(`INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES ('${I.tenant}','${I.branch}','${I.center}','${I.legacyProduct}',1.000);`);
expectReject("legacy aggregate stock requires reconciliation before enable", () => asUser(`SELECT public.configure_product_lot_tracking_v1('${I.tenant}','${I.branch}','${I.center}','${I.legacyProduct}',true,'lot-enable-legacy-0001');`), /zero aggregate stock/i);

expectReject("generic tracked purchase fails closed", () => sql(`SELECT public.apply_inventory_movement('${I.tenant}','${I.branch}','${I.product}','purchase'::public.movement_type,1.000,'unattributed purchase','runtime_test','${receiptA}','${I.manager}','${I.center}');`), /lot-controlled inventory requires a lot-aware inbound or transfer command/i);
assertEqual("failed generic purchase rolls back aggregate stock", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.product}';`), "7.000");

process.stdout.write("Inventory lots/expiry PostgreSQL runtime PASS: idempotent receipt, FEFO, expiry exclusion, rollback, DML lockdown, legacy-stock gate and fail-closed inbound verified.\n");
