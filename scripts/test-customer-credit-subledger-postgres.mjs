import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "b1000000-0000-0000-0000-000000000001",
  tenantB: "b1000000-0000-0000-0000-000000000002",
  branchA: "b2000000-0000-0000-0000-000000000001",
  branchB: "b2000000-0000-0000-0000-000000000002",
  managerA: "b3000000-0000-0000-0000-000000000001",
  cashierA: "b3000000-0000-0000-0000-000000000002",
  managerB: "b3000000-0000-0000-0000-000000000003",
  customerA: "b4000000-0000-0000-0000-000000000001",
  customerB: "b4000000-0000-0000-0000-000000000002",
};

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}
function scalar(statement) {
  return psql(["-Atq", "-c", statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}
function sql(statement) { psql(["-c", statement], false); }
function asUser(userId, statement) {
  return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectReject(label, userId, statement, pattern = /forbidden|tenant|credit|limit|operation|payload|balance|overpay/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

for (const table of ["customer_credit_accounts", "customer_credit_entries", "customer_credit_operations"]) {
  assertEqual(`${table} exists`, scalar(`SELECT to_regclass('public.${table}') IS NOT NULL;`), "t");
}
for (const signature of [
  "public.set_customer_credit_limit_v1(uuid,bigint,text,text)",
  "public.set_customer_credit_opening_balance_v1(uuid,bigint,text,text)",
  "public.record_customer_credit_charge_v1(uuid,bigint,text,text,text)",
  "public.record_customer_credit_payment_v1(uuid,bigint,text,text,text)",
  "public.get_customer_credit_statement_v1(uuid)",
]) {
  assertEqual(`required function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
}

for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
  for (const table of ["customer_credit_accounts", "customer_credit_entries", "customer_credit_operations"]) {
    assertEqual(`authenticated direct ${table} ${privilege} denied`, scalar(`SELECT has_table_privilege('authenticated','public.${table}','${privilege}');`), "f");
  }
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','credit-manager-a@zaipos.test','{}'),
    ('${I.cashierA}','credit-cashier-a@zaipos.test','{}'),
    ('${I.managerB}','credit-manager-b@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Credit Tenant A','credit-tenant-a','BHD',10,false),
    ('${I.tenantB}','Credit Tenant B','credit-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Credit Branch A','active'),
    ('${I.branchB}','${I.tenantB}','Credit Branch B','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}',NULL,'manager'),
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.managerB}','${I.tenantB}',NULL,'manager')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.profiles(id,email,default_tenant_id) VALUES
    ('${I.managerA}','credit-manager-a@zaipos.test','${I.tenantA}'),
    ('${I.cashierA}','credit-cashier-a@zaipos.test','${I.tenantA}'),
    ('${I.managerB}','credit-manager-b@zaipos.test','${I.tenantB}')
  ON CONFLICT (id) DO UPDATE SET default_tenant_id=EXCLUDED.default_tenant_id;
  INSERT INTO public.customers(id,tenant_id,name,status) VALUES
    ('${I.customerA}','${I.tenantA}','Credit Customer A','active'),
    ('${I.customerB}','${I.tenantB}','Credit Customer B','active')
  ON CONFLICT (id) DO NOTHING;
`);

const setLimit = (amount, op = "credit-limit-0001") =>
  `SELECT public.set_customer_credit_limit_v1('${I.customerA}'::uuid,${amount}::bigint,'Approved account limit','${op}');`;
assertEqual("manager sets exact-fils credit limit", asUser(I.managerA, setLimit(5000)), I.customerA);
assertEqual("limit replay is stable", asUser(I.managerA, setLimit(5000)), I.customerA);
expectReject("limit operation is payload-bound", I.managerA, setLimit(6000));
expectReject("cashier cannot set credit limit", I.cashierA, setLimit(5000, "credit-limit-0002"), /forbidden|manager|credit/i);
expectReject("cross-tenant manager cannot set credit limit", I.managerB, setLimit(5000, "credit-limit-0003"), /tenant|forbidden/i);

const opening = asUser(I.managerA,
  `SELECT public.set_customer_credit_opening_balance_v1('${I.customerA}'::uuid,1000::bigint,'Verified legacy receivable','credit-opening-0001');`);
assertEqual("opening balance replay is stable", asUser(I.managerA,
  `SELECT public.set_customer_credit_opening_balance_v1('${I.customerA}'::uuid,1000::bigint,'Verified legacy receivable','credit-opening-0001');`), opening);
expectReject("second distinct opening rejected", I.managerA,
  `SELECT public.set_customer_credit_opening_balance_v1('${I.customerA}'::uuid,1000::bigint,'Duplicate opening','credit-opening-0002');`, /opening|already|credit/i);

const charge = asUser(I.managerA,
  `SELECT public.record_customer_credit_charge_v1('${I.customerA}'::uuid,1500::bigint,'manual_sale','sale-ref-001','credit-charge-0001');`);
assertEqual("charge replay is stable", asUser(I.managerA,
  `SELECT public.record_customer_credit_charge_v1('${I.customerA}'::uuid,1500::bigint,'manual_sale','sale-ref-001','credit-charge-0001');`), charge);
expectReject("charge operation is payload-bound", I.managerA,
  `SELECT public.record_customer_credit_charge_v1('${I.customerA}'::uuid,1600::bigint,'manual_sale','sale-ref-001','credit-charge-0001');`);
expectReject("credit limit cannot be exceeded", I.managerA,
  `SELECT public.record_customer_credit_charge_v1('${I.customerA}'::uuid,3000::bigint,'manual_sale','sale-ref-002','credit-charge-0002');`, /limit|credit|balance/i);

const payment = asUser(I.cashierA,
  `SELECT public.record_customer_credit_payment_v1('${I.customerA}'::uuid,500::bigint,'cash','receipt-credit-001','credit-payment-0001');`);
assertEqual("payment replay is stable", asUser(I.cashierA,
  `SELECT public.record_customer_credit_payment_v1('${I.customerA}'::uuid,500::bigint,'cash','receipt-credit-001','credit-payment-0001');`), payment);
expectReject("payment cannot overpay receivable", I.cashierA,
  `SELECT public.record_customer_credit_payment_v1('${I.customerA}'::uuid,999999::bigint,'cash','receipt-credit-002','credit-payment-0002');`, /overpay|balance|credit/i);

assertEqual("exact reconstructed balance in fils", scalar(`SELECT balance_fils::text FROM public.customer_credit_accounts WHERE customer_id='${I.customerA}'::uuid;`), "2000");
assertEqual("immutable entries reconstruct same balance", scalar(`SELECT COALESCE(sum(amount_fils),0)::text FROM public.customer_credit_entries WHERE customer_id='${I.customerA}'::uuid;`), "2000");
assertEqual("statement returns exact rows", asUser(I.managerA, `SELECT count(*)::text FROM public.get_customer_credit_statement_v1('${I.customerA}'::uuid);`), "3");
expectReject("cross-tenant statement rejected", I.managerB,
  `SELECT count(*)::text FROM public.get_customer_credit_statement_v1('${I.customerA}'::uuid);`, /tenant|forbidden/i);

assertEqual("credit mutations audited", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE tenant_id='${I.tenantA}'::uuid AND entity IN ('customer_credit_accounts','customer_credit_entries');`), "4");

console.log("Customer credit subledger exact-fils/security/runtime contract passed.");
