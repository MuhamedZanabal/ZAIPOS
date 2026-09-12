import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

function queryText(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function scalar(statement) {
  return queryText(statement).split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const signature = "public.get_cash_till_intelligence_v1(uuid,timestamp with time zone,timestamp with time zone)";
assertEqual(
  `required function ${signature}`,
  scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`),
  "t",
);
assertEqual(
  "cash/till intelligence is SECURITY DEFINER",
  scalar(`SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('${signature}');`),
  "t",
);
assertEqual(
  "cash/till intelligence is read-only stable",
  scalar(`SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('${signature}');`),
  "s",
);
assertEqual(
  "PUBLIC cannot execute cash/till intelligence",
  scalar(`SELECT has_function_privilege('public', '${signature}', 'execute');`),
  "f",
);
assertEqual(
  "anon cannot execute cash/till intelligence",
  scalar(`SELECT has_function_privilege('anon', '${signature}', 'execute');`),
  "f",
);
assertEqual(
  "authenticated can execute cash/till intelligence",
  scalar(`SELECT has_function_privilege('authenticated', '${signature}', 'execute');`),
  "t",
);

const definition = queryText(`SELECT pg_get_functiondef(to_regprocedure('${signature}'));`);
for (const required of ["expected_amount_fils", "counted_cash_fils", "difference_fils", "closed_at"]) {
  if (!definition.includes(required)) throw new Error(`cash/till intelligence must source immutable ${required}`);
}
if (/\b(expected_amount|counted_cash|difference)\b(?!_fils)/.test(definition)) {
  throw new Error("cash/till intelligence must not source decimal compatibility money columns");
}

const reports = readFileSync(new URL("../src/modules/reports/Reports.tsx", import.meta.url), "utf8");
if (!/get_cash_till_intelligence_v1/.test(reports)) {
  throw new Error("Reports must expose authoritative closed-session cash/till intelligence");
}
if (/Number\((?:s\.(?:expected_amount|counted_cash|difference)|session\.(?:expected_amount|counted_cash|difference))\)/.test(reports)) {
  throw new Error("Reports must not coerce legacy decimal till money into authority");
}

process.stdout.write("Cash/till intelligence static/runtime boundary contract passed.\n");