import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenant: "a1000000-0000-0000-0000-000000000001",
  otherTenant: "a1000000-0000-0000-0000-000000000002",
  branch: "a2000000-0000-0000-0000-000000000001",
  otherBranch: "a2000000-0000-0000-0000-000000000002",
  center: "a3000000-0000-0000-0000-000000000001",
  otherCenter: "a3000000-0000-0000-0000-000000000002",
  manager: "a4000000-0000-0000-0000-000000000001",
  cashier: "a4000000-0000-0000-0000-000000000002",
  productA: "a5000000-0000-0000-0000-000000000001",
  productB: "a5000000-0000-0000-0000-000000000002",
};

let currentPhase = "bootstrap";
function phase(name) {
  currentPhase = name;
  process.stdout.write(`STOCKTAKE_RUNTIME_PHASE=${name}\n`);
}
function psql(args, capture = true) {
  try {
    return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(`Stocktake runtime failed during phase ${currentPhase}: ${stderr}`, { cause: error });
  }
}
function sql(statement) { return psql(["-c", statement]); }
function scalar(statement) { return psql(["-Atq", "-c", statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ""; }
function asUser(userId, statement) {
  return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`);
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

phase("function-contract");
for (const signature of [
  "public.start_stocktake_v1(uuid,uuid,uuid,jsonb,text)",
  "public.record_stocktake_count_v1(uuid,uuid,numeric,text)",
  "public.finalize_stocktake_v1(uuid,text)",
  "public.cancel_stocktake_v1(uuid,text)",
]) {
  assertEqual(`function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
}
assertEqual("stocktakes table", scalar("SELECT to_regclass('public.stocktakes') IS NOT NULL;"), "t");
assertEqual("stocktake items table", scalar("SELECT to_regclass('public.stocktake_items') IS NOT NULL;"), "t");

phase("fixture-setup");
sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.manager}','stocktake-manager@zaipos.test','{}'),
    ('${I.cashier}','stocktake-cashier@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenant}','Stocktake Tenant','stocktake-tenant','BHD',10,false),
    ('${I.otherTenant}','Other Stocktake Tenant','other-stocktake-tenant','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branch}','${I.tenant}','Stocktake Branch','active'),
    ('${I.otherBranch}','${I.otherTenant}','Other Stocktake Branch','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES
    ('${I.center}','${I.tenant}','${I.branch}','Stocktake Center','warehouse','active'),
    ('${I.otherCenter}','${I.otherTenant}','${I.otherBranch}','Other Stocktake Center','warehouse','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.manager}','${I.tenant}','${I.branch}','manager'),
    ('${I.cashier}','${I.tenant}','${I.branch}','cashier')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.products(id,tenant_id,name,product_type,sku,price,cost,tax_rate,status,barcode) VALUES
    ('${I.productA}','${I.tenant}','Stocktake Cola','simple','ST-CO-A',1.000,0.500,10,'active',NULL),
    ('${I.productB}','${I.tenant}','Stocktake Water','simple','ST-WA-B',0.500,0.200,10,'active',NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity)
  VALUES
    ('${I.tenant}','${I.branch}','${I.center}','${I.productA}',10.000),
    ('${I.tenant}','${I.branch}','${I.center}','${I.productB}',5.000)
  ON CONFLICT (inventory_center_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity, updated_at=now();
`);

phase("authorization-and-snapshot");
expectReject(
  "cashier cannot start stocktake",
  () => asUser(I.cashier, `SELECT public.start_stocktake_v1('${I.tenant}','${I.branch}','${I.center}',jsonb_build_array('${I.productA}'::text),'unauthorized');`),
  /forbidden|permission/i,
);
expectReject(
  "cross-tenant center rejected",
  () => asUser(I.manager, `SELECT public.start_stocktake_v1('${I.tenant}','${I.branch}','${I.otherCenter}',jsonb_build_array('${I.productA}'::text),'wrong center');`),
  /center|branch|tenant|invalid/i,
);

const stocktake = asUser(I.manager, `SELECT public.start_stocktake_v1('${I.tenant}','${I.branch}','${I.center}',jsonb_build_array('${I.productA}'::text,'${I.productB}'::text),'full physical count');`);
assertEqual("stocktake open", scalar(`SELECT status FROM public.stocktakes WHERE id='${stocktake}';`), "open");
assertEqual("snapshot item count", scalar(`SELECT count(*)::text FROM public.stocktake_items WHERE stocktake_id='${stocktake}';`), "2");
assertEqual("snapshot product A", scalar(`SELECT expected_quantity::text FROM public.stocktake_items WHERE stocktake_id='${stocktake}' AND product_id='${I.productA}';`), "10.000");
assertEqual("snapshot product B", scalar(`SELECT expected_quantity::text FROM public.stocktake_items WHERE stocktake_id='${stocktake}' AND product_id='${I.productB}';`), "5.000");

phase("count-idempotency");
const countOperation = asUser(I.manager, `SELECT public.record_stocktake_count_v1('${stocktake}','${I.productA}',9.000,'stocktake-count-0001');`);
const countReplay = asUser(I.manager, `SELECT public.record_stocktake_count_v1('${stocktake}','${I.productA}',9.000,'stocktake-count-0001');`);
assertEqual("count replay returns same operation", countReplay, countOperation);
assertEqual("count persisted", scalar(`SELECT counted_quantity::text FROM public.stocktake_items WHERE stocktake_id='${stocktake}' AND product_id='${I.productA}';`), "9.000");
expectReject(
  "count mutation payload bound",
  () => asUser(I.manager, `SELECT public.record_stocktake_count_v1('${stocktake}','${I.productA}',8.000,'stocktake-count-0001');`),
  /different inventory request|different.*request|mutation/i,
);
expectReject(
  "negative count rejected",
  () => asUser(I.manager, `SELECT public.record_stocktake_count_v1('${stocktake}','${I.productB}',-1.000,'stocktake-count-neg');`),
  /non-negative|quantity/i,
);

phase("incomplete-finalize");
expectReject(
  "all scoped items must be counted",
  () => asUser(I.manager, `SELECT public.finalize_stocktake_v1('${stocktake}','stocktake-final-0001');`),
  /counted|incomplete/i,
);
asUser(I.manager, `SELECT public.record_stocktake_count_v1('${stocktake}','${I.productB}',5.000,'stocktake-count-0002');`);

phase("clean-finalize-and-replay");
const inventoryOperation = asUser(I.manager, `SELECT public.finalize_stocktake_v1('${stocktake}','stocktake-final-0001');`);
assertEqual("stocktake finalized", scalar(`SELECT status FROM public.stocktakes WHERE id='${stocktake}';`), "finalized");
assertEqual("final inventory operation linked", scalar(`SELECT inventory_operation_id::text FROM public.stocktakes WHERE id='${stocktake}';`), inventoryOperation);
assertEqual("physical target applied", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.productA}';`), "9.000");
assertEqual("other target unchanged", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.productB}';`), "5.000");
assertEqual("adjustment evidence", scalar(`SELECT quantity::text FROM public.inventory_movements WHERE reference_type='inventory_operation' AND reference_id='${inventoryOperation}' AND product_id='${I.productA}' ORDER BY created_at DESC LIMIT 1;`), "-1.000");
assertEqual("finalize replay", asUser(I.manager, `SELECT public.finalize_stocktake_v1('${stocktake}','stocktake-final-0001');`), inventoryOperation);
expectReject(
  "finalized session rejects new mutation identity",
  () => asUser(I.manager, `SELECT public.finalize_stocktake_v1('${stocktake}','stocktake-final-OTHER');`),
  /finalized|mutation|different/i,
);

phase("stale-snapshot-fail-closed");
const stale = asUser(I.manager, `SELECT public.start_stocktake_v1('${I.tenant}','${I.branch}','${I.center}',jsonb_build_array('${I.productA}'::text),'stale count test');`);
asUser(I.manager, `SELECT public.record_stocktake_count_v1('${stale}','${I.productA}',9.000,'stocktake-stale-count');`);
sql(`SELECT public.apply_inventory_movement('${I.tenant}','${I.branch}','${I.productA}','sale'::public.movement_type,1.000,'concurrent movement','stocktake_runtime','${inventoryOperation}','${I.manager}','${I.center}');`);
assertEqual("concurrent movement applied", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.productA}';`), "8.000");
expectReject(
  "stale stocktake cannot overwrite concurrent movement",
  () => asUser(I.manager, `SELECT public.finalize_stocktake_v1('${stale}','stocktake-stale-final');`),
  /Inventory changed after this stocktake started|stale|changed/i,
);
assertEqual("stale session remains open", scalar(`SELECT status FROM public.stocktakes WHERE id='${stale}';`), "open");
assertEqual("stale finalize made no correction", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.productA}';`), "8.000");

phase("cancel-and-lockdown");
const cancelled = asUser(I.manager, `SELECT public.start_stocktake_v1('${I.tenant}','${I.branch}','${I.center}',jsonb_build_array('${I.productB}'::text),'cancel test');`);
asUser(I.manager, `SELECT public.cancel_stocktake_v1('${cancelled}','operator abandoned count');`);
assertEqual("cancelled status", scalar(`SELECT status FROM public.stocktakes WHERE id='${cancelled}';`), "cancelled");
expectReject(
  "authenticated direct session mutation denied",
  () => asUser(I.manager, `UPDATE public.stocktakes SET status='finalized' WHERE id='${stale}'; SELECT 'unexpected';`),
  /permission denied/i,
);
expectReject(
  "authenticated direct item mutation denied",
  () => asUser(I.manager, `UPDATE public.stocktake_items SET counted_quantity=0 WHERE stocktake_id='${stale}'; SELECT 'unexpected';`),
  /permission denied/i,
);

phase("audit-evidence");
assertEqual("started audit exists", scalar(`SELECT (count(*) > 0)::text FROM public.audit_logs WHERE entity='stocktakes' AND entity_id='${stocktake}' AND action='stocktake.started';`), "true");
assertEqual("counted audit exists", scalar(`SELECT (count(*) > 0)::text FROM public.audit_logs WHERE entity='stocktakes' AND entity_id='${stocktake}' AND action='stocktake.counted';`), "true");
assertEqual("finalized audit exists", scalar(`SELECT (count(*) > 0)::text FROM public.audit_logs WHERE entity='stocktakes' AND entity_id='${stocktake}' AND action='stocktake.finalized';`), "true");
assertEqual("cancelled audit exists", scalar(`SELECT (count(*) > 0)::text FROM public.audit_logs WHERE entity='stocktakes' AND entity_id='${cancelled}' AND action='stocktake.cancelled';`), "true");

phase("complete");
process.stdout.write("Stocktake PostgreSQL runtime PASS: authorization, snapshots, replay, incomplete/stale rejection, atomic reconciliation, cancellation and DML lockdown verified.\n");
