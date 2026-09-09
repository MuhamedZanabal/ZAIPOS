import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "17000000-0000-0000-0000-000000000121",
  tenantB: "17000000-0000-0000-0000-000000000122",
  branchA: "27000000-0000-0000-0000-000000000121",
  branchB: "27000000-0000-0000-0000-000000000122",
  branchA2: "27000000-0000-0000-0000-000000000123",
  managerA: "37000000-0000-0000-0000-000000000121",
  cashierA: "37000000-0000-0000-0000-000000000122",
  inventoryA: "37000000-0000-0000-0000-000000000123",
  managerB: "37000000-0000-0000-0000-000000000124",
  productA: "57000000-0000-0000-0000-000000000121",
  supplierA: "67000000-0000-0000-0000-000000000121",
  orderA: "77000000-0000-0000-0000-000000000121",
  orderItemA: "87000000-0000-0000-0000-000000000121",
  registerA: "47000000-0000-0000-0000-000000000121",
  sessionA: "47000000-0000-0000-0000-000000000122",
  centerA: "47000000-0000-0000-0000-000000000123",
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
function expectReject(label, userId, statement, pattern = /forbidden|permission|tenant|branch|operation|reason/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}
function expectAdminReject(label, statement, pattern) {
  try { scalar(statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

assertEqual("financial history ledger exists", scalar("SELECT to_regclass('public.product_prices') IS NOT NULL;"), "t");
assertEqual("financial operation ledger exists", scalar("SELECT to_regclass('public.product_financial_operations') IS NOT NULL;"), "t");
for (const signature of [
  "public.set_product_base_financials_v1(uuid,uuid,bigint,bigint,text,text)",
  "public.set_product_selling_price_v1(uuid,uuid,uuid,public.sales_channel,bigint,text,text)",
]) {
  assertEqual(`required function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','financial-manager-a@zaipos.test','{}'),
    ('${I.cashierA}','financial-cashier-a@zaipos.test','{}'),
    ('${I.inventoryA}','financial-inventory-a@zaipos.test','{}'),
    ('${I.managerB}','financial-manager-b@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Financial Tenant A','financial-tenant-a','BHD',10,false),
    ('${I.tenantB}','Financial Tenant B','financial-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Financial Branch A','active'),
    ('${I.branchB}','${I.tenantB}','Financial Branch B','active'),
    ('${I.branchA2}','${I.tenantA}','Financial Branch A2','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}','${I.branchA}','manager'),
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.inventoryA}','${I.tenantA}','${I.branchA}','inventory'),
    ('${I.managerB}','${I.tenantB}','${I.branchB}','manager')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.cash_registers(id,tenant_id,branch_id,name,status) VALUES
    ('${I.registerA}','${I.tenantA}','${I.branchA}','Financial Register','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.cash_sessions(id,tenant_id,branch_id,register_id,user_id,status) VALUES
    ('${I.sessionA}','${I.tenantA}','${I.branchA}','${I.registerA}','${I.cashierA}','open')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES
    ('${I.centerA}','${I.tenantA}','${I.branchA}','Financial Centre','point_of_sale','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status) VALUES
    ('${I.productA}','${I.tenantA}','Financial Water','simple',1.250,0.750,0,'active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.suppliers(id,tenant_id,name,status) VALUES
    ('${I.supplierA}','${I.tenantA}','Financial Supplier','active')
  ON CONFLICT (id) DO NOTHING;
`);

assertEqual("initial selling price captured", scalar(`SELECT amount_fils::text FROM public.product_prices WHERE product_id='${I.productA}'::uuid AND price_type='selling' AND branch_id IS NULL AND channel IS NULL AND effective_to IS NULL;`), "1250");
assertEqual("initial product cost captured", scalar(`SELECT amount_fils::text FROM public.product_prices WHERE product_id='${I.productA}'::uuid AND price_type='cost' AND branch_id IS NULL AND channel IS NULL AND effective_to IS NULL;`), "750");

const baseUpdate = (operationId, price = 1500, cost = 800) => `SELECT public.set_product_base_financials_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,${price}::bigint,${cost}::bigint,'Quarterly catalogue review','${operationId}')::text;`;
expectReject("cashier cannot change financials", I.cashierA, baseUpdate("financial-cashier-denied-121"));
expectReject("cross-tenant manager cannot change financials", I.managerB, baseUpdate("financial-cross-tenant-denied-121"));
assertEqual("manager updates base financials", asUser(I.managerA, baseUpdate("financial-base-update-121")), I.productA);
assertEqual("base financial replay", asUser(I.managerA, baseUpdate("financial-base-update-121")), I.productA);
expectReject("operation cannot be reused with changed amounts", I.managerA, baseUpdate("financial-base-update-121", 1600, 800));
assertEqual("product selling mirror", scalar(`SELECT price_fils::text FROM public.products WHERE id='${I.productA}'::uuid;`), "1500");
assertEqual("product cost mirror", scalar(`SELECT cost_fils::text FROM public.products WHERE id='${I.productA}'::uuid;`), "800");
assertEqual("selling history preserved", scalar(`SELECT count(*)::text FROM public.product_prices WHERE product_id='${I.productA}'::uuid AND price_type='selling' AND branch_id IS NULL AND channel IS NULL;`), "2");
assertEqual("cost history preserved", scalar(`SELECT count(*)::text FROM public.product_prices WHERE product_id='${I.productA}'::uuid AND price_type='cost' AND branch_id IS NULL AND channel IS NULL;`), "2");
assertEqual("previous selling row closed", scalar(`SELECT count(*)::text FROM public.product_prices WHERE product_id='${I.productA}'::uuid AND price_type='selling' AND branch_id IS NULL AND channel IS NULL AND amount_fils=1250 AND effective_to IS NOT NULL;`), "1");
assertEqual("base update audit exactly once", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='catalogue.product_financials_changed' AND entity_id='${I.productA}'::uuid;`), "1");

const channelUpdate = (operationId, amount) => `SELECT public.set_product_selling_price_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'${I.branchA}'::uuid,'talabat'::public.sales_channel,${amount}::bigint,'Talabat fee review','${operationId}')::text;`;
assertEqual("manager sets branch channel price", asUser(I.managerA, channelUpdate("financial-channel-update-121", 1750)), I.productA);
assertEqual("channel compatibility mirror", scalar(`SELECT price_fils::text FROM public.product_channel_prices WHERE tenant_id='${I.tenantA}'::uuid AND product_id='${I.productA}'::uuid AND branch_id='${I.branchA}'::uuid AND channel='talabat';`), "1750");
assertEqual("manager changes branch channel price", asUser(I.managerA, channelUpdate("financial-channel-update-122", 1800)), I.productA);
assertEqual("channel price history preserved", scalar(`SELECT count(*)::text FROM public.product_prices WHERE product_id='${I.productA}'::uuid AND price_type='selling' AND branch_id='${I.branchA}'::uuid AND channel='talabat';`), "2");
expectReject("wrong-tenant branch is rejected", I.managerA, `SELECT public.set_product_selling_price_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'${I.branchB}'::uuid,'talabat'::public.sales_channel,1900::bigint,'Invalid branch','financial-wrong-branch-121');`);
expectReject("manager cannot change another assigned branch", I.managerA, `SELECT public.set_product_selling_price_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'${I.branchA2}'::uuid,'talabat'::public.sales_channel,1900::bigint,'Invalid branch scope','financial-wrong-branch-122');`, /forbidden|branch/i);

sql(`
  INSERT INTO public.purchase_orders(id,tenant_id,branch_id,supplier_id,status,total,notes) VALUES
    ('${I.orderA}','${I.tenantA}','${I.branchA}','${I.supplierA}','draft',1.300,'Cost history receipt')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.purchase_order_items(id,order_id,tenant_id,product_id,product_name,quantity,cost_price,line_total) VALUES
    ('${I.orderItemA}','${I.orderA}','${I.tenantA}','${I.productA}','Financial Water',2.000,0.650,1.300)
  ON CONFLICT (id) DO NOTHING;
`);
const receive = `SELECT public.receive_purchase_order_v2('${I.orderA}'::uuid,'${I.centerA}'::uuid,'financial-receipt-operation-121')::text;`;
const receiptOperation = asUser(I.inventoryA, receive);
assertEqual("purchase receipt replay", asUser(I.inventoryA, receive), receiptOperation);
assertEqual("received unit cost fils", scalar(`SELECT cost_price_fils::text FROM public.purchase_order_items WHERE id='${I.orderItemA}'::uuid;`), "650");
assertEqual("received line cost fils", scalar(`SELECT line_total_fils::text FROM public.purchase_order_items WHERE id='${I.orderItemA}'::uuid;`), "1300");
assertEqual("receipt cost history captured once", scalar(`SELECT count(*)::text FROM public.product_prices WHERE purchase_order_item_id='${I.orderItemA}'::uuid AND price_type='cost' AND amount_fils=650;`), "1");
assertEqual("receipt cost source", scalar(`SELECT source FROM public.product_prices WHERE purchase_order_item_id='${I.orderItemA}'::uuid;`), "purchase_receipt");
assertEqual("receipt updates current product cost", scalar(`SELECT cost_fils::text FROM public.products WHERE id='${I.productA}'::uuid;`), "650");

const items = JSON.stringify([{ product_id: I.productA, quantity: "1.000", discount_fils: 0 }]).replaceAll("'", "''");
const payments = JSON.stringify([{ method: "cash", amount_fils: 1500, reference: null }]).replaceAll("'", "''");
const checkout = `SELECT public.checkout_sale_v2('${I.tenantA}'::uuid,'${I.branchA}'::uuid,'${items}'::jsonb,'${payments}'::jsonb,0::bigint,NULL,NULL::uuid,'pos'::public.sales_channel,0::bigint,NULL,'financial-checkout-operation-121','${I.sessionA}'::uuid)::text;`;
const saleId = asUser(I.cashierA, checkout);
assertEqual("sale snapshots received unit cost", scalar(`SELECT unit_cost_fils::text FROM public.sale_items WHERE sale_id='${saleId}'::uuid;`), "650");
assertEqual("sale snapshots historical COGS", scalar(`SELECT line_cost_fils::text FROM public.sale_items WHERE sale_id='${saleId}'::uuid;`), "650");
assertEqual("sale links cost evidence", scalar(`SELECT cost_price_id IS NOT NULL FROM public.sale_items WHERE sale_id='${saleId}'::uuid;`), "t");
assertEqual("sale identifies cost basis", scalar(`SELECT cost_basis FROM public.sale_items WHERE sale_id='${saleId}'::uuid;`), "purchase_receipt");

assertEqual("manager changes later financials", asUser(I.managerA, baseUpdate("financial-base-update-122", 1600, 900)), I.productA);
assertEqual("historical sale cost remains immutable", scalar(`SELECT line_cost_fils::text FROM public.sale_items WHERE sale_id='${saleId}'::uuid;`), "650");
assertEqual("historical gross profit reproducible", scalar(`SELECT (line_total_fils-line_cost_fils)::text FROM public.sale_items WHERE sale_id='${saleId}'::uuid;`), "850");

expectReject("manager cannot bypass financial command", I.managerA, `UPDATE public.products SET price=9.999,cost=8.888 WHERE id='${I.productA}'::uuid`, /command|permission denied/i);
expectReject("manager cannot bypass channel-price command", I.managerA, `UPDATE public.product_channel_prices SET price=9.999 WHERE tenant_id='${I.tenantA}'::uuid AND product_id='${I.productA}'::uuid`, /command|permission denied/i);
expectAdminReject("historical COGS cannot be rewritten", `UPDATE public.sale_items SET unit_cost_fils=1 WHERE sale_id='${saleId}'::uuid`, /immutable|check constraint/i);
expectAdminReject("product with financial history cannot be deleted", `DELETE FROM public.products WHERE id='${I.productA}'::uuid`, /foreign key|violates/i);
assertEqual("cross-tenant history hidden", asUser(I.managerB, `SELECT count(*)::text FROM public.product_prices WHERE tenant_id='${I.tenantA}'::uuid;`), "0");
for (const table of ["product_prices", "product_financial_operations"]) {
  for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
    assertEqual(`${table} authenticated ${privilege}`, scalar(`SELECT has_table_privilege('authenticated','public.${table}','${privilege}');`), "f");
  }
}

process.stdout.write("Product financial history PASS: exact selling/cost ledgers, tenant and branch authorization, receipt costs, immutable COGS, audit, idempotency and direct-write lockdown hold.\n");
