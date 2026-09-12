import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "aa460000-0000-0000-0000-000000000001",
  tenantB: "aa460000-0000-0000-0000-000000000002",
  branchA: "bb460000-0000-0000-0000-000000000001",
  branchB: "bb460000-0000-0000-0000-000000000002",
  managerA: "cc460000-0000-0000-0000-000000000001",
  centerA: "dd460000-0000-0000-0000-000000000001",
  outProduct: "ee460000-0000-0000-0000-000000000001",
  lowProduct: "ee460000-0000-0000-0000-000000000002",
  lotProduct: "ee460000-0000-0000-0000-000000000003",
  expiredLot: "ff460000-0000-0000-0000-000000000001",
  soonLot: "ff460000-0000-0000-0000-000000000002",
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
function assertTrue(label, condition) {
  if (!condition) throw new Error(`${label}: expected true`);
}
function expectReject(label, userId, statement, pattern = /forbidden|unauthori|branch|tenant|authenticated/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

const signature = "public.get_branch_operational_alerts_v1(uuid,date)";
assertEqual("operational alert controller exists", scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
assertEqual("anonymous cannot execute alerts", scalar(`SELECT has_function_privilege('anon','${signature}','EXECUTE');`), "f");
assertEqual("authenticated can execute alerts", scalar(`SELECT has_function_privilege('authenticated','${signature}','EXECUTE');`), "t");
assertEqual("service role cannot bypass alert authorization", scalar(`SELECT has_function_privilege('service_role','${signature}','EXECUTE');`), "f");

const definition = psql(["-Atq", "-c", `SELECT pg_get_functiondef('${signature}'::regprocedure);`]).trim();
for (const forbiddenMutation of ["INSERT INTO public.sales", "UPDATE public.sales", "DELETE FROM public.sales", "UPDATE public.inventory_stocks", "DELETE FROM public.inventory_lots"]) {
  assertTrue(`alert controller excludes ${forbiddenMutation}`, !definition.includes(forbiddenMutation));
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','alerts-manager@zaipos.test','{}') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Alerts Tenant A','alerts-tenant-a','BHD',10,false),
    ('${I.tenantB}','Alerts Tenant B','alerts-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Alerts Branch A','active'),
    ('${I.branchB}','${I.tenantB}','Alerts Branch B','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES
    ('${I.centerA}','${I.tenantA}','${I.branchA}','Alerts Center','warehouse','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}','${I.branchA}','manager') ON CONFLICT DO NOTHING;
  INSERT INTO public.products(id,tenant_id,name,product_type,sku,price,cost,tax_rate,status,barcode,min_stock) VALUES
    ('${I.outProduct}','${I.tenantA}','Out Product','simple','ALERT-OUT',1.000,0.500,10,'active',NULL,3),
    ('${I.lowProduct}','${I.tenantA}','Low Product','simple','ALERT-LOW',1.000,0.500,10,'active',NULL,5),
    ('${I.lotProduct}','${I.tenantA}','Lot Product','simple','ALERT-LOT',1.000,0.500,10,'active',NULL,0)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.outProduct}',0.000),
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.lowProduct}',2.000),
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.lotProduct}',8.000)
  ON CONFLICT (inventory_center_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity;
  INSERT INTO public.inventory_lots(id,tenant_id,branch_id,inventory_center_id,product_id,batch_number,expiry_date,received_quantity,quantity_remaining,is_quarantined) VALUES
    ('${I.expiredLot}','${I.tenantA}','${I.branchA}','${I.centerA}','${I.lotProduct}','EXPIRED','2026-09-11',4.000,4.000,false),
    ('${I.soonLot}','${I.tenantA}','${I.branchA}','${I.centerA}','${I.lotProduct}','SOON','2026-09-30',4.000,4.000,false)
  ON CONFLICT (id) DO NOTHING;
`);

const raw = asUser(I.managerA, `SELECT public.get_branch_operational_alerts_v1('${I.branchA}','2026-09-12')::text`);
const result = JSON.parse(raw);
assertEqual("alert mode", result.mode, "read_only");
assertEqual("scope branch", result.scope?.branch_id, I.branchA);
assertEqual("scope tenant", result.scope?.tenant_id, I.tenantA);
assertEqual("scope as-of", result.scope?.as_of_date, "2026-09-12");
assertEqual("authoritative evidence", result.evidence?.authoritative, true);
assertEqual("evidence money unit", result.evidence?.money_unit, "fils");
assertTrue("alerts array", Array.isArray(result.alerts));

const byType = new Map(result.alerts.map((alert) => [alert.type, alert]));
for (const type of ["out_of_stock", "low_stock", "expired_lot", "expiring_lot"]) {
  assertTrue(`${type} emitted`, byType.has(type));
}
assertEqual("out-of-stock severity", byType.get("out_of_stock")?.severity, "critical");
assertEqual("low-stock severity", byType.get("low_stock")?.severity, "warning");
assertEqual("expired-lot severity", byType.get("expired_lot")?.severity, "critical");
assertEqual("expiring-lot severity", byType.get("expiring_lot")?.severity, "warning");
assertEqual("expired lot source id", byType.get("expired_lot")?.source_id, I.expiredLot);
assertEqual("expiring lot source id", byType.get("expiring_lot")?.source_id, I.soonLot);
assertTrue("all alerts carry branch scope", result.alerts.every((alert) => alert.branch_id === I.branchA));
assertTrue("all alerts carry source ids", result.alerts.every((alert) => typeof alert.source_id === "string" && alert.source_id.length > 0));
assertTrue("no mutation authority advertised", result.limitations?.some((item) => /no business-state mutation/i.test(item)));

expectReject("cross-tenant branch access", I.managerA, `SELECT public.get_branch_operational_alerts_v1('${I.branchB}','2026-09-12')`);

process.stdout.write("Operational alerts PostgreSQL contract PASS: deterministic stock/expiry alerts, provenance, branch authorization and read-only boundary verified.\n");