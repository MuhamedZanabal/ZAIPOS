import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

function scalar(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const signature = "public.get_branch_reporting_snapshot_v1(uuid,timestamp with time zone,timestamp with time zone)";
assertEqual(
  `required function ${signature}`,
  scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`),
  "t",
);

const dashboard = readFileSync(new URL("../src/modules/dashboard/Dashboard.tsx", import.meta.url), "utf8");
const forbidden = [
  ["hard-coded sales sparkline", /const\s+SPARK\s*=\s*\[/],
  ["hard-coded top products", /const\s+TOP_PRODUCTS\s*=\s*\[/],
  ["hard-coded channel percentages", /totalSales\s*\*\s*0\.(52|24|16|08)/],
  ["hard-coded KPI deltas", /delta=\"(?:18\.5%|12%)\"/],
  ["hard-coded out-of-stock count", />12<\/div>/],
  ["unsupported sync success claim", /Everything synchronized/],
  ["legacy sales monetary read", /from\(\"sales\"\)\.select\(\"id,total\"\)/],
  ["legacy payment monetary read", /from\(\"payments\"\)\.select\(\"method, amount,/],
  ["client money coercion", /Number\((?:r\.total|p\.amount|s\.total)\)/],
];

const violations = forbidden.filter(([, pattern]) => pattern.test(dashboard)).map(([label]) => label);
if (violations.length) {
  throw new Error(`Dashboard contains non-authoritative reporting behavior: ${violations.join(", ")}`);
}

if (!/get_branch_reporting_snapshot_v1/.test(dashboard)) {
  throw new Error("Dashboard must source reporting truth from get_branch_reporting_snapshot_v1");
}

process.stdout.write("Deterministic reporting static/runtime boundary contract passed.\n");
