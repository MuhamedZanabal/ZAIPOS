import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "16000000-0000-0000-0000-000000000111",
  tenantB: "16000000-0000-0000-0000-000000000112",
  managerA: "36000000-0000-0000-0000-000000000111",
  cashierA: "36000000-0000-0000-0000-000000000112",
  managerB: "36000000-0000-0000-0000-000000000113",
  productA: "56000000-0000-0000-0000-000000000111",
  productRetired: "56000000-0000-0000-0000-000000000112",
  productB: "56000000-0000-0000-0000-000000000113",
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
function expectReject(label, userId, statement, pattern = /forbidden|permission|tenant|collision|malformed|duplicate|primary/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}
function expectDatabaseReject(label, statement, pattern) {
  try { scalar(statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

assertEqual("barcode ledger exists", scalar("SELECT to_regclass('public.product_barcodes') IS NOT NULL;"), "t");
assertEqual("collision ledger exists", scalar("SELECT to_regclass('public.product_barcode_conflicts') IS NOT NULL;"), "t");
for (const signature of [
  "public.inspect_product_barcode_candidates_v1(uuid,uuid,jsonb)",
  "public.replace_product_barcodes_v1(uuid,uuid,jsonb,text)",
  "public.resolve_product_by_barcode_v1(uuid,text)",
  "public.resolve_product_barcode_conflict_v1(uuid,text,text)",
]) {
  assertEqual(`required function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','barcode-manager-a@zaipos.test','{}'),
    ('${I.cashierA}','barcode-cashier-a@zaipos.test','{}'),
    ('${I.managerB}','barcode-manager-b@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Barcode Tenant A','barcode-tenant-a','BHD',10,false),
    ('${I.tenantB}','Barcode Tenant B','barcode-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}',NULL,'manager'),
    ('${I.cashierA}','${I.tenantA}',NULL,'cashier'),
    ('${I.managerB}','${I.tenantB}',NULL,'manager')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status,barcode) VALUES
    ('${I.productA}','${I.tenantA}','Barcode Water','simple',1.250,0.750,10,'active',' 6290000000777 '),
    ('${I.productRetired}','${I.tenantA}','Retired Case','simple',1.000,0.500,10,'inactive','OLD-CASE-24'),
    ('${I.productB}','${I.tenantB}','Other Tenant Water','simple',1.250,0.750,10,'active','TENANT-SHARED')
  ON CONFLICT (id) DO NOTHING;
`);

assertEqual("legacy primary mirrored", scalar(`SELECT barcode FROM public.product_barcodes WHERE product_id='${I.productA}'::uuid AND is_primary;`), "6290000000777");
assertEqual("legacy field normalized", scalar(`SELECT barcode FROM public.products WHERE id='${I.productA}'::uuid;`), "6290000000777");
expectDatabaseReject(
  "database rejects malformed typed EAN",
  `INSERT INTO public.product_barcodes(tenant_id,product_id,barcode,barcode_type,is_primary,sort_order) VALUES ('${I.tenantA}'::uuid,'${I.productA}'::uuid,'123','ean_8',false,9)`,
  /product_barcodes_format_check/i,
);

const candidateJson = JSON.stringify([
  { barcode: "6290000000777", barcode_type: "ean_13", is_primary: true },
  { barcode: "CASE-24-A", barcode_type: "supplier", is_primary: false },
]).replaceAll("'", "''");
const replace = (operation, payload = candidateJson) => `SELECT public.replace_product_barcodes_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'${payload}'::jsonb,'${operation}')::text;`;
expectReject("cashier cannot replace barcodes", I.cashierA, replace("barcode-replace-cashier-111"));
expectReject("cross-tenant manager cannot replace barcodes", I.managerB, replace("barcode-replace-cross-tenant-111"));
assertEqual("manager replaces barcode set", asUser(I.managerA, replace("barcode-replace-operation-111")), I.productA);
assertEqual("replace replay", asUser(I.managerA, replace("barcode-replace-operation-111")), I.productA);
assertEqual("two barcode rows", scalar(`SELECT count(*)::text FROM public.product_barcodes WHERE product_id='${I.productA}'::uuid;`), "2");
assertEqual("one primary", scalar(`SELECT count(*)::text FROM public.product_barcodes WHERE product_id='${I.productA}'::uuid AND is_primary;`), "1");
assertEqual("legacy primary remains", scalar(`SELECT barcode FROM public.products WHERE id='${I.productA}'::uuid;`), "6290000000777");
assertEqual("alternate resolves", asUser(I.cashierA, `SELECT public.resolve_product_by_barcode_v1('${I.tenantA}'::uuid,' case-24-a ')::text;`), I.productA);
assertEqual("cross-tenant barcode hidden", asUser(I.managerB, `SELECT public.resolve_product_by_barcode_v1('${I.tenantB}'::uuid,'CASE-24-A') IS NULL;`), "true");
assertEqual("cross-tenant barcode rows hidden by RLS", asUser(I.managerB, `SELECT count(*)::text FROM public.product_barcodes WHERE product_id='${I.productA}'::uuid;`), "0");
assertEqual("replace audit exactly once", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='catalogue.product_barcodes_replaced' AND entity_id='${I.productA}'::uuid;`), "1");
expectReject(
  "manager cannot bypass barcode command through products",
  I.managerA,
  `UPDATE public.products SET barcode='BYPASS-CODE' WHERE id='${I.productA}'::uuid`,
  /must use replace_product_barcodes_v1/i,
);
expectReject(
  "operation ID cannot be reused with changed barcode input",
  I.managerA,
  replace("barcode-replace-operation-111", `[{"barcode":"DIFFERENT-CODE","barcode_type":"code_128","is_primary":true}]`),
  /operation ID.*different input/i,
);

const retiredConflict = JSON.parse(asUser(I.managerA, `SELECT public.inspect_product_barcode_candidates_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'[{"barcode":"OLD-CASE-24","barcode_type":"supplier","is_primary":true}]'::jsonb)::text;`));
assertEqual("retired collision classified", retiredConflict[0].state, "retired_product_conflict");
assertEqual("retired collision identifies owner", retiredConflict[0].conflicting_product_id, I.productRetired);
const malformed = JSON.parse(asUser(I.managerA, `SELECT public.inspect_product_barcode_candidates_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'[{"barcode":"BAD CODE","barcode_type":"code_128","is_primary":true},{"barcode":"123","barcode_type":"ean_8","is_primary":false},{"barcode":"123","barcode_type":"ean_8","is_primary":false}]'::jsonb)::text;`));
assertEqual("malformed classified", malformed[0].state, "malformed");
assertEqual("invalid EAN classified", malformed[1].state, "malformed");
assertEqual("duplicate input classified", malformed[2].state, "duplicate_input");
expectReject("collision cannot be committed", I.managerA, replace("barcode-replace-collision-111", `[{"barcode":"OLD-CASE-24","barcode_type":"supplier","is_primary":true}]`));

const reviewConflictId = scalar(`INSERT INTO public.product_barcode_conflicts(
  tenant_id,candidate_product_id,conflicting_product_id,barcode,normalized_barcode,source,details
) VALUES ('${I.tenantA}'::uuid,'${I.productA}'::uuid,'${I.productRetired}'::uuid,'OLD-CASE-24','OLD-CASE-24','manual','{"reason":"duplicate"}') RETURNING id::text;`);
const resolveConflict = `SELECT public.resolve_product_barcode_conflict_v1('${reviewConflictId}'::uuid,'keep_existing','barcode-conflict-resolution-111')::text;`;
expectReject("cashier cannot resolve conflict", I.cashierA, resolveConflict);
assertEqual("manager resolves conflict", asUser(I.managerA, resolveConflict), reviewConflictId);
assertEqual("conflict resolution replay", asUser(I.managerA, resolveConflict), reviewConflictId);
assertEqual("conflict resolution audited once", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='catalogue.product_barcode_conflict_resolved' AND entity_id='${reviewConflictId}'::uuid;`), "1");

const tenantBPayload = JSON.stringify([{ barcode: "CASE-24-A", barcode_type: "supplier", is_primary: true }]).replaceAll("'", "''");
assertEqual(
  "same normalized barcode is valid in another tenant",
  asUser(I.managerB, `SELECT public.replace_product_barcodes_v1('${I.tenantB}'::uuid,'${I.productB}'::uuid,'${tenantBPayload}'::jsonb,'barcode-replace-tenant-b-111')::text;`),
  I.productB,
);

for (const table of ["product_barcodes", "product_barcode_conflicts", "product_barcode_operations"]) {
  for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
    assertEqual(`${table} authenticated ${privilege}`, scalar(`SELECT has_table_privilege('authenticated','public.${table}','${privilege}');`), "f");
  }
}

process.stdout.write("Product barcodes PASS: tenant uniqueness, primary compatibility, collision evidence, authorization, idempotency, audit and direct-write lockdown hold.\n");
