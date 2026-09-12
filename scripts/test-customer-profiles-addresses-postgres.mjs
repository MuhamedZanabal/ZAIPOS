import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

function scalar(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(label, actual, expected) {
  if (!actual.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}

assertEqual(
  "customer_addresses exists",
  scalar("SELECT to_regclass('public.customer_addresses') IS NOT NULL;"),
  "t",
);

for (const [column, type] of [
  ["tenant_id", "uuid"],
  ["customer_id", "uuid"],
  ["label", "text"],
  ["recipient_name", "text"],
  ["phone", "text"],
  ["building", "text"],
  ["road", "text"],
  ["block", "text"],
  ["area", "text"],
  ["city", "text"],
  ["notes", "text"],
  ["is_default", "boolean"],
  ["status", "text"],
]) {
  assertEqual(
    `customer_addresses.${column}`,
    scalar(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='customer_addresses' AND column_name='${column}';`),
    type,
  );
}

const addressIndexes = scalar(`
  SELECT COALESCE(string_agg(indexdef, E'\n' ORDER BY indexname), '')
  FROM pg_indexes
  WHERE schemaname='public' AND tablename='customer_addresses';
`);
assertIncludes("default-address uniqueness references customer", addressIndexes, "customer_id");
assertIncludes("default-address uniqueness is partial", addressIndexes, "is_default");

for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
  assertEqual(
    `authenticated direct customer ${privilege} denied`,
    scalar(`SELECT has_table_privilege('authenticated','public.customers','${privilege}');`),
    "f",
  );
  assertEqual(
    `authenticated direct customer address ${privilege} denied`,
    scalar(`SELECT has_table_privilege('authenticated','public.customer_addresses','${privilege}');`),
    "f",
  );
}

assertEqual(
  "customer_addresses RLS enabled",
  scalar("SELECT relrowsecurity FROM pg_class WHERE oid='public.customer_addresses'::regclass;"),
  "t",
);

for (const signature of [
  "public.upsert_customer_profile_v1(uuid,jsonb,text)",
  "public.upsert_customer_address_v1(uuid,uuid,jsonb,text)",
  "public.archive_customer_address_v1(uuid,uuid,text)",
  "public.archive_customer_profile_v1(uuid,text)",
]) {
  assertEqual(
    `required function ${signature}`,
    scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`),
    "t",
  );
}

const profileFn = scalar("SELECT pg_get_functiondef('public.upsert_customer_profile_v1(uuid,jsonb,text)'::regprocedure);");
assertIncludes("profile command binds operation id", profileFn, "operation_id");
assertIncludes("profile command audits mutation", profileFn, "audit_logs");
assertIncludes("profile command resolves tenant from auth", profileFn, "auth.uid");

const addressFn = scalar("SELECT pg_get_functiondef('public.upsert_customer_address_v1(uuid,uuid,jsonb,text)'::regprocedure);");
assertIncludes("address command binds operation id", addressFn, "operation_id");
assertIncludes("address command enforces tenant customer", addressFn, "tenant_id");
assertIncludes("address command handles default address", addressFn, "is_default");

console.log("Customer profiles and addresses schema/security contract passed.");
