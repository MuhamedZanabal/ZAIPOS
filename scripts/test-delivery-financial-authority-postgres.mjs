import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

function scalar(sql) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql], {
    cwd: root,
    encoding: "utf8",
  }).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

assertEqual(
  "delivery_orders has authoritative integer-fils delivery fee",
  scalar(`SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='delivery_orders' AND column_name='delivery_fee_fils';`),
  "bigint:NO",
);

assertEqual(
  "authoritative delivery registration v2 exists",
  scalar(`SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='register_delivery_order_v2';`),
  "1",
);

assertEqual(
  "legacy delivery registration is not executable by authenticated clients",
  scalar(`SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname='register_delivery_order'
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) THEN 'f' ELSE 't' END;`),
  "t",
);

console.log("Delivery financial-authority PostgreSQL contract: PASS");
