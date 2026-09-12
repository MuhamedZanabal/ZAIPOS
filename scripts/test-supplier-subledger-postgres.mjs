import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "1b000000-0000-0000-0000-000000000111",
  tenantB: "1b000000-0000-0000-0000-000000000112",
  branchA: "2b000000-0000-0000-0000-000000000111",
  branchB: "2b000000-0000-0000-0000-000000000112",
  centerA: "3b000000-0000-0000-0000-000000000111",
  managerA: "4b000000-0000-0000-0000-000000000111",
  inventoryA: "4b000000-0000-0000-0000-000000000112",
  cashierA: "4b000000-0000-0000-0000-000000000113",
  managerB: "4b000000-0000-0000-0000-000000000114",
  productA: "5b000000-0000-0000-0000-000000000111",
  supplierA: "6b000000-0000-0000-0000-000000000111",
  supplierB: "6b000000-0000-0000-0000-000000000112",
  orderA: "7b000000-0000-0000-0000-000000000111",
  orderLegacyShape: "7b000000-0000-0000-0000-000000000112",
  orderNoSupplier: "7b000000-0000-0000-0000-000000000113",
  itemA: "8b000000-0000-0000-0000-000000000111",
  itemLegacy: "8b000000-0000-0000-0000-000000000112",
  itemNoSupplier: "8b000000-0000-0000-0000-000000000113",
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
function expectReject(label, userId, statement, pattern = /forbidden|permission|tenant|branch|supplier|operation|opening|payable|authenticated/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

for (const table of ["supplier_subledger_cutovers","supplier_ledger_entries","supplier_financial_operations"]) {
  assertEqual(`${table} exists`, scalar(`SELECT to_regclass('public.${table}') IS NOT NULL;`), "t");
}
for (const signature of [
  "public.set_supplier_opening_balance_v1(uuid,uuid,uuid,bigint,text,text)",
  "public.record_supplier_payment_v1(uuid,uuid,uuid,bigint,text,text,text,text)",
  "public.get_supplier_statement_v1(uuid,uuid,uuid)",
]) {
  assertEqual(`required function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','supplier-manager-a@zaipos.test','{}'),
    ('${I.inventoryA}','supplier-inventory-a@zaipos.test','{}'),
    ('${I.cashierA}','supplier-cashier-a@zaipos.test','{}'),
    ('${I.managerB}','supplier-manager-b@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Supplier Tenant A','supplier-tenant-a','BHD',10,false),
    ('${I.tenantB}','Supplier Tenant B','supplier-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Supplier Branch A','active'),
    ('${I.branchB}','${I.tenantB}','Supplier Branch B','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.supplier_subledger_cutovers(tenant_id,branch_id,activated_at) VALUES
    ('${I.tenantA}','${I.branchA}',now() - interval '1 day'),
    ('${I.tenantB}','${I.branchB}',now() - interval '1 day')
  ON CONFLICT (tenant_id,branch_id) DO UPDATE SET activated_at=EXCLUDED.activated_at;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}','${I.branchA}','manager'),
    ('${I.inventoryA}','${I.tenantA}','${I.branchA}','inventory'),
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.managerB}','${I.tenantB}','${I.branchB}','manager')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES
    ('${I.centerA}','${I.tenantA}','${I.branchA}','Supplier Main Stock','warehouse','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status,barcode) VALUES
    ('${I.productA}','${I.tenantA}','Supplier Test Water','simple',1.000,0.650,0,'active',NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.suppliers(id,tenant_id,name,status) VALUES
    ('${I.supplierA}','${I.tenantA}','Supplier A','active'),
    ('${I.supplierB}','${I.tenantA}','Supplier B','active')
  ON CONFLICT (id) DO NOTHING;

  -- A row inserted already in received state represents pre-cutover historical shape.
  -- The subledger must not fabricate an unpaid liability from it.
  INSERT INTO public.purchase_orders(id,tenant_id,branch_id,supplier_id,status,total,notes,received_at) VALUES
    ('${I.orderLegacyShape}','${I.tenantA}','${I.branchA}','${I.supplierA}','received',0.500,'Legacy received shape',now()-interval '2 days')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.purchase_order_items(id,order_id,tenant_id,product_id,product_name,quantity,cost_price,line_total) VALUES
    ('${I.itemLegacy}','${I.orderLegacyShape}','${I.tenantA}','${I.productA}','Supplier Test Water',1.000,0.500,0.500)
  ON CONFLICT (id) DO NOTHING;
`);

assertEqual(
  "historical received PO is not presumed unpaid",
  scalar(`SELECT count(*)::text FROM public.supplier_ledger_entries WHERE purchase_order_id='${I.orderLegacyShape}'::uuid;`),
  "0",
);

const opening = (operationId, amount = 0) => `SELECT public.set_supplier_opening_balance_v1('${I.tenantA}','${I.branchA}','${I.supplierA}',${amount}::bigint,'Cutover payable confirmed','${operationId}')::text;`;
const openingEntry = asUser(I.managerA, opening("supplier-opening-111"));
assertEqual("opening balance replay", asUser(I.managerA, opening("supplier-opening-111")), openingEntry);
assertEqual("opening balance exactly once", scalar(`SELECT count(*)::text FROM public.supplier_ledger_entries WHERE id='${openingEntry}'::uuid AND entry_type='opening_balance' AND amount_fils=0;`), "1");
expectReject("opening operation payload mismatch", I.managerA, opening("supplier-opening-111", 100));
expectReject("second distinct opening is rejected", I.managerA, opening("supplier-opening-112", 0));

sql(`
  INSERT INTO public.purchase_orders(id,tenant_id,branch_id,supplier_id,status,total,notes) VALUES
    ('${I.orderA}','${I.tenantA}','${I.branchA}','${I.supplierA}','draft',1.300,'Supplier subledger receipt')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.purchase_order_items(id,order_id,tenant_id,product_id,product_name,quantity,cost_price,line_total) VALUES
    ('${I.itemA}','${I.orderA}','${I.tenantA}','${I.productA}','Supplier Test Water',2.000,0.650,1.300)
  ON CONFLICT (id) DO NOTHING;
`);

const receive = `SELECT public.receive_purchase_order_v2('${I.orderA}'::uuid,'${I.centerA}'::uuid,'supplier-receipt-operation-111')::text;`;
const receiptOperation = asUser(I.inventoryA, receive);
assertEqual("purchase receipt replay", asUser(I.inventoryA, receive), receiptOperation);
assertEqual("receipt payable exactly once", scalar(`SELECT count(*)::text FROM public.supplier_ledger_entries WHERE purchase_order_id='${I.orderA}'::uuid AND entry_type='purchase_receipt';`), "1");
assertEqual("receipt payable exact fils", scalar(`SELECT amount_fils::text FROM public.supplier_ledger_entries WHERE purchase_order_id='${I.orderA}'::uuid;`), "1300");
assertEqual("receipt actor retained", scalar(`SELECT recorded_by='${I.inventoryA}'::uuid FROM public.supplier_ledger_entries WHERE purchase_order_id='${I.orderA}'::uuid;`), "t");
assertEqual("receipt audit exactly once", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='supplier.purchase_payable_recognized' AND metadata->>'purchase_order_id'='${I.orderA}';`), "1");

sql(`
  INSERT INTO public.purchase_orders(id,tenant_id,branch_id,supplier_id,status,total,notes) VALUES
    ('${I.orderNoSupplier}','${I.tenantA}','${I.branchA}',NULL,'draft',0.650,'Missing supplier receipt')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.purchase_order_items(id,order_id,tenant_id,product_id,product_name,quantity,cost_price,line_total) VALUES
    ('${I.itemNoSupplier}','${I.orderNoSupplier}','${I.tenantA}','${I.productA}','Supplier Test Water',1.000,0.650,0.650)
  ON CONFLICT (id) DO NOTHING;
`);
expectReject(
  "receipt without supplier fails closed",
  I.inventoryA,
  `SELECT public.receive_purchase_order_v2('${I.orderNoSupplier}'::uuid,'${I.centerA}'::uuid,'supplier-receipt-operation-112')::text;`,
  /supplier|payable/i,
);
assertEqual("failed receipt rolls back PO state", scalar(`SELECT status FROM public.purchase_orders WHERE id='${I.orderNoSupplier}'::uuid;`), "draft");

const payment = (operationId, amount = 800, method = "bank_transfer") => `SELECT public.record_supplier_payment_v1('${I.tenantA}','${I.branchA}','${I.supplierA}',${amount}::bigint,'${method}','BANK-REF-111','Part payment','${operationId}')::text;`;
const paymentEntry = asUser(I.managerA, payment("supplier-payment-111"));
assertEqual("supplier payment replay", asUser(I.managerA, payment("supplier-payment-111")), paymentEntry);
assertEqual("payment exactly once", scalar(`SELECT count(*)::text FROM public.supplier_ledger_entries WHERE id='${paymentEntry}'::uuid AND entry_type='payment' AND amount_fils=800;`), "1");
expectReject("payment operation payload mismatch", I.managerA, payment("supplier-payment-111", 900));
expectReject("cashier cannot record payment", I.cashierA, payment("supplier-payment-cashier-111"));
expectReject("inventory role cannot record payment", I.inventoryA, payment("supplier-payment-inventory-111"));
expectReject(
  "other tenant manager cannot record payment",
  I.managerB,
  `SELECT public.record_supplier_payment_v1('${I.tenantA}','${I.branchA}','${I.supplierA}',100::bigint,'cash',NULL,NULL,'supplier-payment-cross-111')::text;`,
);
assertEqual("payment audit exactly once", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='supplier.payment_recorded' AND entity_id='${paymentEntry}'::uuid;`), "1");

const statement = JSON.parse(asUser(I.managerA, `
  SELECT COALESCE(json_agg(json_build_object(
    'entry_type',entry_type,
    'amount_fils',amount_fils,
    'balance_delta_fils',balance_delta_fils,
    'running_balance_fils',running_balance_fils,
    'coverage_status',coverage_status
  ) ORDER BY occurred_at,entry_id),'[]'::json)::text
  FROM public.get_supplier_statement_v1('${I.tenantA}','${I.branchA}','${I.supplierA}')
`));
assertEqual("statement entry count", String(statement.length), "3");
assertEqual("opening statement type", statement[0].entry_type, "opening_balance");
assertEqual("receipt statement delta", String(statement[1].balance_delta_fils), "1300");
assertEqual("payment statement delta", String(statement[2].balance_delta_fils), "-800");
assertEqual("final supplier payable", String(statement[2].running_balance_fils), "500");
assertEqual("statement coverage complete from cutover", statement[2].coverage_status, "complete_from_cutover");

// A supplier with post-cutover activity but no opening balance must expose incomplete coverage.
sql(`
  INSERT INTO public.supplier_ledger_entries(tenant_id,branch_id,supplier_id,entry_type,amount_fils,payment_method,operation_id,note,recorded_by)
  VALUES('${I.tenantA}','${I.branchA}','${I.supplierB}','payment',100,'cash','supplier-test-seed-111','Coverage seed','${I.managerA}');
`);
const incompleteCoverage = asUser(I.managerA, `SELECT DISTINCT coverage_status FROM public.get_supplier_statement_v1('${I.tenantA}','${I.branchA}','${I.supplierB}')`);
assertEqual("missing opening balance is explicit", incompleteCoverage, "opening_balance_required");
sql(`DELETE FROM public.supplier_ledger_entries WHERE operation_id='supplier-test-seed-111';`);

expectReject(
  "cashier cannot read supplier statement",
  I.cashierA,
  `SELECT count(*) FROM public.get_supplier_statement_v1('${I.tenantA}','${I.branchA}','${I.supplierA}')`,
);
expectReject(
  "wrong-tenant branch statement rejected",
  I.managerA,
  `SELECT count(*) FROM public.get_supplier_statement_v1('${I.tenantA}','${I.branchB}','${I.supplierA}')`,
);

expectReject(
  "authenticated client cannot insert supplier ledger",
  I.managerA,
  `INSERT INTO public.supplier_ledger_entries(tenant_id,branch_id,supplier_id,entry_type,amount_fils,operation_id,payment_method) VALUES('${I.tenantA}','${I.branchA}','${I.supplierA}','payment',1,'supplier-direct-write-111','cash')`,
  /permission|denied/i,
);
expectReject(
  "authenticated client cannot update supplier ledger",
  I.managerA,
  `UPDATE public.supplier_ledger_entries SET amount_fils=999 WHERE id='${paymentEntry}'::uuid`,
  /permission|denied/i,
);
expectReject(
  "authenticated client cannot delete supplier ledger",
  I.managerA,
  `DELETE FROM public.supplier_ledger_entries WHERE id='${paymentEntry}'::uuid`,
  /permission|denied/i,
);
expectReject(
  "authenticated client cannot mutate supplier operation ledger",
  I.managerA,
  `UPDATE public.supplier_financial_operations SET completed_at=NULL WHERE operation_id='supplier-payment-111'`,
  /permission|denied/i,
);

console.log("Supplier subledger runtime contract passed.");
