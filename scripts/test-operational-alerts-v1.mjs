import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const signature = "public.get_operational_alerts_v1(uuid,timestamp with time zone,integer,integer)";

function scalar(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}
function text(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

assertEqual(`required function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
assertEqual("operational alerts are SECURITY DEFINER", scalar(`SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('${signature}');`), "t");
assertEqual("operational alerts are STABLE", scalar(`SELECT provolatile FROM pg_proc WHERE oid=to_regprocedure('${signature}');`), "s");
assertEqual("PUBLIC cannot execute alerts", scalar(`SELECT has_function_privilege('public','${signature}','execute');`), "f");
assertEqual("anon cannot execute alerts", scalar(`SELECT has_function_privilege('anon','${signature}','execute');`), "f");
assertEqual("authenticated can execute alerts", scalar(`SELECT has_function_privilege('authenticated','${signature}','execute');`), "t");

const definition = text(`SELECT pg_get_functiondef(to_regprocedure('${signature}'));`);
for (const required of [
  "inventory_stocks",
  "min_stock",
  "inventory_lots",
  "quantity_remaining",
  "expiry_date",
  "cash_sessions",
  "difference_fils",
  "closed_at",
  "out_of_stock",
  "low_stock",
  "expired_lot_stock",
  "expiry_due",
  "cash_variance",
  "_expiry_horizon_days",
  "_cash_lookback_days",
]) {
  if (!definition.includes(required)) throw new Error(`operational alert authority missing ${required}`);
}
if (/\bdifference\b(?!_fils)/.test(definition)) {
  throw new Error("cash variance alerts must not source legacy decimal difference authority");
}
const bounds = definition.match(/>\s*365/g) ?? [];
if (bounds.length < 2) {
  throw new Error("expiry horizon and cash lookback must each be explicitly bounded to 0..365 days");
}

process.stdout.write("Operational alerts v1 static/database boundary contract passed.\n");
