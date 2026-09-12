import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const signature = "public.get_branch_operational_alerts_v1(uuid,date)";

function query(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const definition = query(`SELECT pg_get_functiondef('${signature}'::regprocedure);`);
for (const required of [
  "get_cash_till_intelligence_v1",
  "difference_fils",
  "cash_variance",
  "cash_session",
  "closed_at",
]) {
  if (!definition.includes(required)) {
    throw new Error(`Operational alert cash-variance authority missing ${required}`);
  }
}

if (/\b(expected_amount|counted_cash|difference)\b(?!_fils)/.test(definition)) {
  throw new Error("Cash variance alerts must not source legacy decimal money authority");
}

if (!definition.includes("interval '7 days'")) {
  throw new Error("Cash variance alert lookback must be explicit and bounded to seven days");
}

if (!definition.includes("difference_fils <> 0")) {
  throw new Error("Cash variance alerts must be evidence-triggered without an invented monetary threshold");
}

process.stdout.write("Operational alerts cash-variance contract PASS: exact-fils till authority, explicit lookback and source-backed discrepancy class verified.\n");
