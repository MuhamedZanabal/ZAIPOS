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

const checkoutEvidence = scalar("SELECT pg_get_functiondef('public.capture_checkout_loyalty_evidence_v1()'::regprocedure);");
assertIncludes("checkout evidence uses immutable ledger", checkoutEvidence, "customer_loyalty_ledger");
assertIncludes("checkout evidence snapshots loyalty policy", checkoutEvidence, "points_per_thousand_snapshot");
assertEqual(
  "checkout evidence trigger installed",
  scalar("SELECT count(*)::text FROM pg_trigger WHERE tgrelid='public.operation_log'::regclass AND tgname='capture_checkout_loyalty_evidence';"),
  "1",
);

const returnReversal = scalar("SELECT pg_get_functiondef('public.apply_return_loyalty_reversal_v1()'::regprocedure);");
assertIncludes("return reversal uses immutable ledger", returnReversal, "customer_loyalty_ledger");
assertEqual(
  "return reversal trigger installed",
  scalar("SELECT count(*)::text FROM pg_trigger WHERE tgrelid='public.sale_returns'::regclass AND tgname='apply_return_loyalty_reversal';"),
  "1",
);
const guard = scalar("SELECT pg_get_functiondef('public.guard_customer_linked_return_without_loyalty_evidence()'::regprocedure);");
assertIncludes("legacy returns still fail closed without exact award", guard, "customer_loyalty_ledger");
assertIncludes("legacy return guard checks sale award", guard, "sale_earn");

const voidReversal = scalar("SELECT pg_get_functiondef('public.apply_void_loyalty_reversal_v1()'::regprocedure);");
assertIncludes("void reversal uses immutable ledger", voidReversal, "customer_loyalty_ledger");
assertEqual(
  "void reversal trigger installed",
  scalar("SELECT count(*)::text FROM pg_trigger WHERE tgrelid='public.sale_voids'::regclass AND tgname='apply_void_loyalty_reversal';"),
  "1",
);
const voidFn = scalar("SELECT pg_get_functiondef('public.process_sale_void_v2(uuid,text,uuid,text)'::regprocedure);");
if (voidFn.includes("Customer-linked sale void requires loyalty reversal evidence")) {
  throw new Error("customer-linked void still fails closed even when exact loyalty evidence can be reversed");
}

console.log("Customer loyalty ledger schema/integration contract passed.");
