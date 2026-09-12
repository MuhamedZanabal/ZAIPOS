import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "1a100000-0000-0000-0000-000000000001",
  tenantB: "1a100000-0000-0000-0000-000000000002",
  branchA: "2a100000-0000-0000-0000-000000000001",
  branchB: "2a100000-0000-0000-0000-000000000002",
  managerA: "3a100000-0000-0000-0000-000000000001",
};

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}
function sql(statement) { return psql(["-c", statement], false); }
function scalar(statement) {
  return psql(["-Atq", "-c", statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}
function asUser(userId, statement) {
  return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(label, condition) {
  if (!condition) throw new Error(`${label}: expected true`);
}
function expectReject(label, userId, statement, pattern = /forbidden|unauthori|branch|tenant|range|question/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

const signature = "public.ai_read_reporting_context_v1(uuid,timestamp with time zone,timestamp with time zone,text)";
assertEqual("AI read controller exists", scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
assertEqual("anonymous cannot execute AI read controller", scalar(`SELECT has_function_privilege('anon','${signature}','EXECUTE');`), "f");
assertEqual("authenticated can execute AI read controller", scalar(`SELECT has_function_privilege('authenticated','${signature}','EXECUTE');`), "t");
assertEqual("service role cannot bypass AI read controller auth", scalar(`SELECT has_function_privilege('service_role','${signature}','EXECUTE');`), "f");

const definition = scalar(`SELECT pg_get_functiondef('${signature}'::regprocedure);`);
assertTrue("controller delegates to reporting authority", definition.includes("get_branch_reporting_snapshot_v1"));
for (const forbiddenMutation of ["INSERT INTO public.sales", "UPDATE public.sales", "DELETE FROM public.sales", "ai_create_digital_order", "ai_quote_order"]) {
  assertTrue(`controller definition excludes ${forbiddenMutation}`, !definition.includes(forbiddenMutation));
}

for (const legacy of [
  "public.ai_search_catalog(uuid,uuid,text,integer)",
  "public.ai_quote_order(uuid,uuid,jsonb,public.sales_channel)",
  "public.ai_create_digital_order(uuid,uuid,uuid,jsonb,text,text,text,text)",
  "public.ai_handoff_to_human(uuid,text)",
]) {
  for (const role of ["anon", "authenticated", "service_role"]) {
    assertEqual(`${role} remains blocked from ${legacy}`, scalar(`SELECT has_function_privilege('${role}','${legacy}','EXECUTE');`), "f");
  }
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','ai-read-manager@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','AI Read Tenant A','ai-read-tenant-a','BHD',10,false),
    ('${I.tenantB}','AI Read Tenant B','ai-read-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','AI Read Branch A','active'),
    ('${I.branchB}','${I.tenantB}','AI Read Branch B','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}','${I.branchA}','manager')
  ON CONFLICT DO NOTHING;
`);

const start = "2026-09-01T00:00:00Z";
const end = "2026-09-02T00:00:00Z";
const raw = asUser(
  I.managerA,
  `SELECT public.ai_read_reporting_context_v1('${I.branchA}','${start}','${end}','What were sales and stock conditions?')::text`,
);
const result = JSON.parse(raw);
assertEqual("read mode", result.mode, "read_only");
assertEqual("scope branch", result.scope?.branch_id, I.branchA);
assertEqual("scope tenant", result.scope?.tenant_id, I.tenantA);
assertEqual("scope start", result.scope?.start_at, start);
assertEqual("scope end", result.scope?.end_at, end);
assertEqual("source type", result.evidence?.source_type, "branch_reporting_snapshot_v1");
assertTrue("generated timestamp exists", typeof result.evidence?.generated_at === "string" && result.evidence.generated_at.length > 10);
assertTrue("source ids array", Array.isArray(result.evidence?.source_ids));
assertTrue("fact payload exists", result.fact && typeof result.fact === "object");
assertTrue("exact fils sales field", Number.isInteger(result.fact.total_sales_fils));
assertTrue("exact fils average field", Number.isInteger(result.fact.average_ticket_fils));
assertTrue("evidence does not invent source ids", result.evidence.source_ids.every((id) => typeof id === "string"));

expectReject(
  "cross-tenant branch access",
  I.managerA,
  `SELECT public.ai_read_reporting_context_v1('${I.branchB}','${start}','${end}','Show sales')`,
);
expectReject(
  "empty question",
  I.managerA,
  `SELECT public.ai_read_reporting_context_v1('${I.branchA}','${start}','${end}','   ')`,
);
expectReject(
  "reversed range",
  I.managerA,
  `SELECT public.ai_read_reporting_context_v1('${I.branchA}','${end}','${start}','Show sales')`,
);

const workspace = readFileSync(new URL("../src/modules/ai-agent/AIAgent.tsx", import.meta.url), "utf8");
assertTrue("AI workspace uses source-backed controller", workspace.includes("ai_read_reporting_context_v1"));
assertTrue("AI workspace labels source evidence", /evidence|source-backed/i.test(workspace));
assertTrue("P0 locked badge removed after source-backed activation", !workspace.includes("P0 LOCKED"));
for (const forbidden of ["ai_create_digital_order", "ai_quote_order", "ai_handoff_to_human", "create_order"]) {
  assertTrue(`AI workspace does not expose ${forbidden}`, !workspace.includes(forbidden));
}

process.stdout.write("P2 AI read-controller contract PASS: authorized source-backed reporting facts, exact fils, evidence scope, service-role denial, and legacy mutation lockdown verified.\n");
