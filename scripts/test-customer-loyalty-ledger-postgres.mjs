import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
function scalar(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertIncludes(label, actual, expected) {
  if (!actual.toLowerCase().includes(expected.toLowerCase())) throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
}

assertEqual("loyalty ledger exists", scalar("SELECT to_regclass('public.customer_loyalty_ledger') IS NOT NULL;"), "t");
for (const [column, type] of [
  ["tenant_id", "uuid"],
  ["branch_id", "uuid"],
  ["customer_id", "uuid"],
  ["event_type", "text"],
  ["points_delta", "bigint"],
  ["points_per_thousand_snapshot", "bigint"],
  ["sale_id", "uuid"],
  ["return_id", "uuid"],
  ["void_id", "uuid"],
  ["operation_id", "text"],
  ["request_payload", "jsonb"],
]) {
  assertEqual(
    `customer_loyalty_ledger.${column}`,
    scalar(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='customer_loyalty_ledger' AND column_name='${column}';`),
    type,
  );
}

const indexes = scalar(`SELECT COALESCE(string_agg(indexdef, E'\n' ORDER BY indexname),'') FROM pg_indexes WHERE schemaname='public' AND tablename='customer_loyalty_ledger';`);
assertIncludes("one sale award", indexes, "sale_id");
assertIncludes("one return reversal", indexes, "return_id");
assertIncludes("one void reversal", indexes, "void_id");
assertIncludes("operation id uniqueness", indexes, "operation_id");

for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
  assertEqual(
    `authenticated direct loyalty ledger ${privilege} denied`,
    scalar(`SELECT has_table_privilege('authenticated','public.customer_loyalty_ledger','${privilege}');`),
    "f",
  );
}
assertEqual("loyalty ledger RLS enabled", scalar("SELECT relrowsecurity FROM pg_class WHERE oid='public.customer_loyalty_ledger'::regclass;"), "t");

const checkout = scalar("SELECT pg_get_functiondef('public.checkout_sale_v2(uuid,uuid,jsonb,jsonb,bigint,text,uuid,public.sales_channel,text)'::regprocedure);");
assertIncludes("checkout persists loyalty evidence", checkout, "customer_loyalty_ledger");
assertIncludes("checkout snapshots loyalty policy", checkout, "points_per_thousand_snapshot");

const returnFn = scalar("SELECT pg_get_functiondef('public.process_sale_return_v2(uuid,jsonb,text,text,uuid,text,text)'::regprocedure);");
assertIncludes("return reverses loyalty", returnFn, "customer_loyalty_ledger");
assertIncludes("return no longer fail-closed by legacy trigger", scalar("SELECT count(*)::text FROM pg_trigger WHERE tgrelid='public.sale_returns'::regclass AND tgname='guard_customer_linked_return_loyalty';"), "0");

const voidFn = scalar("SELECT pg_get_functiondef('public.process_sale_void_v2(uuid,text,uuid,text)'::regprocedure);");
assertIncludes("void reverses loyalty", voidFn, "customer_loyalty_ledger");
if (voidFn.includes("Customer-linked sale void requires loyalty reversal evidence")) {
  throw new Error("customer-linked void still fails closed instead of using exact loyalty evidence");
}

console.log("Customer loyalty ledger schema/integration contract passed.");
