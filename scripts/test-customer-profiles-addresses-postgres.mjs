import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "a1000000-0000-0000-0000-000000000001",
  tenantB: "a1000000-0000-0000-0000-000000000002",
  managerA: "a2000000-0000-0000-0000-000000000001",
  cashierA: "a2000000-0000-0000-0000-000000000002",
  managerB: "a2000000-0000-0000-0000-000000000003",
  customerA: "a3000000-0000-0000-0000-000000000001",
  customerB: "a3000000-0000-0000-0000-000000000002",
  address1: "a4000000-0000-0000-0000-000000000001",
  address2: "a4000000-0000-0000-0000-000000000002",
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
function text(statement) {
  return psql(["-Atq", "-c", statement]).trim();
}
function sql(statement) { psql(["-c", statement], false); }
function asUser(userId, statement) {
  return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertIncludes(label, actual, expected) {
  if (!actual.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}
function expectReject(label, userId, statement, pattern = /forbidden|tenant|operation|payload|field|archiv/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

assertEqual("customer_addresses exists", scalar("SELECT to_regclass('public.customer_addresses') IS NOT NULL;"), "t");
for (const [column, type] of [
  ["tenant_id", "uuid"], ["customer_id", "uuid"], ["label", "text"],
  ["recipient_name", "text"], ["phone", "text"], ["building", "text"],
  ["road", "text"], ["block", "text"], ["area", "text"], ["city", "text"],
  ["notes", "text"], ["is_default", "boolean"], ["status", "text"],
]) {
  assertEqual(`customer_addresses.${column}`,
    scalar(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='customer_addresses' AND column_name='${column}';`), type);
}
const addressIndexes = scalar(`SELECT COALESCE(string_agg(indexdef, E'\n' ORDER BY indexname), '') FROM pg_indexes WHERE schemaname='public' AND tablename='customer_addresses';`);
assertIncludes("default-address uniqueness references customer", addressIndexes, "customer_id");
assertIncludes("default-address uniqueness is partial", addressIndexes, "is_default");

for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
  assertEqual(`authenticated direct customer ${privilege} denied`, scalar(`SELECT has_table_privilege('authenticated','public.customers','${privilege}');`), "f");
  assertEqual(`authenticated direct customer address ${privilege} denied`, scalar(`SELECT has_table_privilege('authenticated','public.customer_addresses','${privilege}');`), "f");
}
assertEqual("customer_addresses RLS enabled", scalar("SELECT relrowsecurity FROM pg_class WHERE oid='public.customer_addresses'::regclass;"), "t");

for (const signature of [
  "public.upsert_customer_profile_v1(uuid,jsonb,text)",
  "public.upsert_customer_address_v1(uuid,uuid,jsonb,text)",
  "public.archive_customer_address_v1(uuid,uuid,text)",
  "public.archive_customer_profile_v1(uuid,text)",
]) {
  assertEqual(`required function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
}
const profileFn = text("SELECT pg_get_functiondef('public.upsert_customer_profile_v1(uuid,jsonb,text)'::regprocedure);");
assertIncludes("profile command binds operation id", profileFn, "operation_id");
assertIncludes("profile command audits mutation", profileFn, "audit_logs");
assertIncludes("profile command resolves tenant from auth", profileFn, "auth.uid");
const addressFn = text("SELECT pg_get_functiondef('public.upsert_customer_address_v1(uuid,uuid,jsonb,text)'::regprocedure);");
assertIncludes("address command binds operation id", addressFn, "operation_id");
assertIncludes("address command enforces tenant customer", addressFn, "tenant_id");
assertIncludes("address command handles default address", addressFn, "is_default");

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','customer-manager-a@zaipos.test','{}'),
    ('${I.cashierA}','customer-cashier-a@zaipos.test','{}'),
    ('${I.managerB}','customer-manager-b@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Customer Tenant A','customer-tenant-a','BHD',10,false),
    ('${I.tenantB}','Customer Tenant B','customer-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}',NULL,'manager'),
    ('${I.cashierA}','${I.tenantA}',NULL,'cashier'),
    ('${I.managerB}','${I.tenantB}',NULL,'manager')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.profiles(id,email,default_tenant_id) VALUES
    ('${I.managerA}','customer-manager-a@zaipos.test','${I.tenantA}'),
    ('${I.cashierA}','customer-cashier-a@zaipos.test','${I.tenantA}'),
    ('${I.managerB}','customer-manager-b@zaipos.test','${I.tenantB}')
  ON CONFLICT (id) DO UPDATE SET default_tenant_id=EXCLUDED.default_tenant_id;
`);

const profilePayload = `{"name":"Aisha Test","phone":"+97333112233","email":"aisha@example.test","document_number":"900000001","address":"Legacy Road 1"}`;
const created = asUser(I.cashierA, `SELECT public.upsert_customer_profile_v1('${I.customerA}'::uuid, '${profilePayload}'::jsonb, 'cust-create-0001');`);
assertEqual("cashier can create tenant customer", created, I.customerA);
assertEqual("profile create replay is stable", asUser(I.cashierA, `SELECT public.upsert_customer_profile_v1('${I.customerA}'::uuid, '${profilePayload}'::jsonb, 'cust-create-0001');`), I.customerA);
expectReject("profile operation id is payload-bound", I.cashierA,
  `SELECT public.upsert_customer_profile_v1('${I.customerA}'::uuid, '{"name":"Different"}'::jsonb, 'cust-create-0001');`, /operation|different|payload/i);
expectReject("profile cannot mutate loyalty aggregate", I.cashierA,
  `SELECT public.upsert_customer_profile_v1('${I.customerA}'::uuid, '{"name":"Aisha Test","loyalty_points":999999}'::jsonb, 'cust-loyalty-0001');`, /field|loyalty|unsupported/i);

asUser(I.managerB, `SELECT public.upsert_customer_profile_v1('${I.customerB}'::uuid, '{"name":"Tenant B Customer"}'::jsonb, 'cust-create-b001');`);
expectReject("cross-tenant profile update rejected", I.managerA,
  `SELECT public.upsert_customer_profile_v1('${I.customerB}'::uuid, '{"name":"Hijack"}'::jsonb, 'cust-cross-0001');`, /tenant|forbidden/i);

const address1Payload = `{"label":"Home","recipient_name":"Aisha Test","phone":"+97333112233","building":"12","road":"101","block":"320","area":"Manama","city":"Manama","notes":"Blue gate","is_default":true}`;
assertEqual("create first structured address", asUser(I.cashierA,
  `SELECT public.upsert_customer_address_v1('${I.customerA}'::uuid,'${I.address1}'::uuid,'${address1Payload}'::jsonb,'addr-create-0001');`), I.address1);
assertEqual("address replay is stable", asUser(I.cashierA,
  `SELECT public.upsert_customer_address_v1('${I.customerA}'::uuid,'${I.address1}'::uuid,'${address1Payload}'::jsonb,'addr-create-0001');`), I.address1);

const address2Payload = `{"label":"Work","recipient_name":"Aisha Test","phone":"+97333112233","building":"20","road":"220","block":"410","area":"Seef","city":"Manama","is_default":true}`;
assertEqual("create second structured address", asUser(I.cashierA,
  `SELECT public.upsert_customer_address_v1('${I.customerA}'::uuid,'${I.address2}'::uuid,'${address2Payload}'::jsonb,'addr-create-0002');`), I.address2);
assertEqual("exactly one active default", scalar(`SELECT count(*) FROM public.customer_addresses WHERE tenant_id='${I.tenantA}' AND customer_id='${I.customerA}' AND status='active' AND is_default;`), "1");
assertEqual("new default replaced old default", scalar(`SELECT is_default::text FROM public.customer_addresses WHERE id='${I.address1}';`), "false");
expectReject("cross-tenant address mutation rejected", I.managerB,
  `SELECT public.upsert_customer_address_v1('${I.customerA}'::uuid,'${I.address1}'::uuid,'${address1Payload}'::jsonb,'addr-cross-0001');`, /tenant|forbidden/i);

assertEqual("archive address command succeeds", asUser(I.managerA,
  `SELECT public.archive_customer_address_v1('${I.customerA}'::uuid,'${I.address2}'::uuid,'addr-archive-0001');`), I.address2);
assertEqual("archived address row retained", scalar(`SELECT status FROM public.customer_addresses WHERE id='${I.address2}';`), "archived");
assertEqual("remaining address promoted to default", scalar(`SELECT is_default::text FROM public.customer_addresses WHERE id='${I.address1}';`), "true");
expectReject("cashier cannot archive customer", I.cashierA,
  `SELECT public.archive_customer_profile_v1('${I.customerA}'::uuid,'cust-archive-denied');`, /forbidden|manager/i);
assertEqual("manager archives customer", asUser(I.managerA,
  `SELECT public.archive_customer_profile_v1('${I.customerA}'::uuid,'cust-archive-0001');`), I.customerA);
assertEqual("archived customer row retained", scalar(`SELECT status::text FROM public.customers WHERE id='${I.customerA}';`), "inactive");

assertEqual("profile create audited", scalar(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${I.tenantA}' AND entity='customers' AND entity_id='${I.customerA}' AND action='customer_profile_upsert';`), "1");
assertEqual("address mutations audited", scalar(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${I.tenantA}' AND entity='customer_addresses' AND entity_id IN ('${I.address1}','${I.address2}');`), "3");

console.log("Customer profiles and addresses schema/security/runtime contract passed.");
