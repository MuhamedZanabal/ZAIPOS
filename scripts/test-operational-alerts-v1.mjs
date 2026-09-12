import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "aa470000-0000-0000-0000-000000000001",
  tenantB: "aa470000-0000-0000-0000-000000000002",
  branchA: "bb470000-0000-0000-0000-000000000001",
  branchB: "bb470000-0000-0000-0000-000000000002",
  managerA: "cc470000-0000-0000-0000-000000000001",
  centerA: "dd470000-0000-0000-0000-000000000001",
  outProduct: "ee470000-0000-0000-0000-000000000001",
  lowProduct: "ee470000-0000-0000-0000-000000000002",
  lotProduct: "ee470000-0000-0000-0000-000000000003",
  expiredLot: "ff470000-0000-0000-0000-000000000001",
  dueLot: "ff470000-0000-0000-0000-000000000002",
  futureLot: "ff470000-0000-0000-0000-000000000003",
  recentCash: "ab470000-0000-0000-0000-000000000001",
  oldCash: "ab470000-0000-0000-0000-000000000002",
};

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}
function sql(statement) { return psql(["-c", statement], false); }
function scalar(statement) { return psql(["-Atq", "-c", statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ""; }
function text(statement) { return psql(["-Atq", "-c", statement]).trim(); }
function asUser(userId, statement) {
  return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(label, condition) {
  if (!condition) throw new Error(`${label}: expected true`);
}
function expectReject(label, userId, statement, pattern = /forbidden|unauthori|branch|tenant|between|authenticated/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

const signature = "public.get_operational_alerts_v1(uuid,timestamp with time zone,integer,integer)";
assertEqual(`required function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
assertEqual("operational alerts are SECURITY DEFINER", scalar(`SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('${signature}');`), "t");
assertEqual("operational alerts are STABLE", scalar(`SELECT provolatile FROM pg_proc WHERE oid=to_regprocedure('${signature}');`), "s");
assertEqual("PUBLIC cannot execute alerts", scalar(`SELECT has_function_privilege('public','${signature}','execute');`), "f");
assertEqual("anon cannot execute alerts", scalar(`SELECT has_function_privilege('anon','${signature}','execute');`), "f");
assertEqual("service_role cannot execute alerts", scalar(`SELECT has_function_privilege('service_role','${signature}','execute');`), "f");
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
for (const forbiddenMutation of ["INSERT INTO public.sales", "UPDATE public.sales", "DELETE FROM public.sales", "UPDATE public.inventory_stocks", "DELETE FROM public.inventory_lots", "UPDATE public.cash_sessions"]) {
  assertTrue(`alert controller excludes ${forbiddenMutation}`, !definition.includes(forbiddenMutation));
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','alerts-v1-manager@zaipos.test','{}') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Alerts V1 Tenant A','alerts-v1-tenant-a','BHD',10,false),
    ('${I.tenantB}','Alerts V1 Tenant B','alerts-v1-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Alerts V1 Branch A','active'),
    ('${I.branchB}','${I.tenantB}','Alerts V1 Branch B','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES
    ('${I.centerA}','${I.tenantA}','${I.branchA}','Alerts V1 Center','warehouse','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}','${I.branchA}','manager') ON CONFLICT DO NOTHING;
  INSERT INTO public.products(id,tenant_id,name,product_type,sku,price,cost,tax_rate,status,barcode,min_stock) VALUES
    ('${I.outProduct}','${I.tenantA}','Out Product V1','simple','ALERT-V1-OUT',1.000,0.500,10,'active',NULL,3),
    ('${I.lowProduct}','${I.tenantA}','Threshold Product V1','simple','ALERT-V1-LOW',1.000,0.500,10,'active',NULL,5),
    ('${I.lotProduct}','${I.tenantA}','Lot Product V1','simple','ALERT-V1-LOT',1.000,0.500,10,'active',NULL,0)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.outProduct}',0.000),
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.lowProduct}',5.000),
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.lotProduct}',12.000)
  ON CONFLICT (inventory_center_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity;
  INSERT INTO public.inventory_lots(id,tenant_id,branch_id,inventory_center_id,product_id,batch_number,expiry_date,received_quantity,quantity_remaining,is_quarantined) VALUES
    ('${I.expiredLot}','${I.tenantA}','${I.branchA}','${I.centerA}','${I.lotProduct}','V1-EXPIRED','2026-09-11',4.000,4.000,false),
    ('${I.dueLot}','${I.tenantA}','${I.branchA}','${I.centerA}','${I.lotProduct}','V1-DUE','2026-09-15',4.000,4.000,false),
    ('${I.futureLot}','${I.tenantA}','${I.branchA}','${I.centerA}','${I.lotProduct}','V1-FUTURE','2026-10-31',4.000,4.000,false)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.cash_sessions(
    id,tenant_id,branch_id,user_id,status,opened_at,closed_at,
    opening_amount,opening_amount_fils,closing_amount,closing_amount_fils,
    expected_amount,expected_amount_fils,difference,difference_fils,
    total_cash,total_cash_fils,total_card,total_card_fils,total_transfer,total_transfer_fils,
    total_qr,total_qr_fils,total_in,total_in_fils,total_out,total_out_fils,
    counted_cash,counted_cash_fils,counted_card,counted_card_fils,
    counted_transfer,counted_transfer_fils,counted_qr,counted_qr_fils
  ) VALUES
    ('${I.recentCash}','${I.tenantA}','${I.branchA}','${I.managerA}','closed','2026-09-11T08:00:00Z','2026-09-11T12:00:00Z',
     20.000,20000,20.125,20125,20.000,20000,0.125,125,
     0,0,0,0,0,0,0,0,0,0,0,0,20.125,20125,0,0,0,0,0,0),
    ('${I.oldCash}','${I.tenantA}','${I.branchA}','${I.managerA}','closed','2026-08-19T08:00:00Z','2026-08-20T12:00:00Z',
     20.000,20000,20.500,20500,20.000,20000,0.500,500,
     0,0,0,0,0,0,0,0,0,0,0,0,20.500,20500,0,0,0,0,0,0)
  ON CONFLICT (id) DO NOTHING;
`);

const statement = `SELECT public.get_operational_alerts_v1('${I.branchA}','2026-09-12T12:00:00Z',7,7)::text`;
const raw = asUser(I.managerA, statement);
const repeatedRaw = asUser(I.managerA, statement);
assertEqual("deterministic repeated result", repeatedRaw, raw);
const result = JSON.parse(raw);

assertEqual("alert mode", result.mode, "read_only");
assertEqual("scope branch", result.scope?.branch_id, I.branchA);
assertEqual("scope tenant", result.scope?.tenant_id, I.tenantA);
assertEqual("Bahrain as-of date", result.scope?.as_of_date_bahrain, "2026-09-12");
assertEqual("expiry horizon evidence", Number(result.scope?.expiry_horizon_days), 7);
assertEqual("cash lookback evidence", Number(result.scope?.cash_lookback_days), 7);
assertEqual("authoritative evidence", result.evidence?.authoritative, true);
assertEqual("evidence money unit", result.evidence?.money_unit, "fils");
assertTrue("alerts array", Array.isArray(result.alerts));

const byType = new Map(result.alerts.map((alert) => [alert.type, alert]));
for (const type of ["out_of_stock", "low_stock", "expired_lot_stock", "expiry_due", "cash_variance"]) {
  assertTrue(`${type} emitted`, byType.has(type));
}
assertEqual("out-of-stock severity", byType.get("out_of_stock")?.severity, "critical");
assertEqual("threshold equality is low stock", byType.get("low_stock")?.source_id, I.lowProduct);
assertEqual("expired lot source", byType.get("expired_lot_stock")?.source_id, I.expiredLot);
assertEqual("expiry due source", byType.get("expiry_due")?.source_id, I.dueLot);
assertEqual("cash variance source", byType.get("cash_variance")?.source_id, I.recentCash);
assertEqual("cash variance exact fils", Number(byType.get("cash_variance")?.evidence?.difference_fils), 125);
assertTrue("future lot outside explicit horizon", !result.alerts.some((alert) => alert.source_id === I.futureLot));
assertTrue("old cash session outside explicit lookback", !result.alerts.some((alert) => alert.source_id === I.oldCash));
assertTrue("all alerts carry branch scope", result.alerts.every((alert) => alert.branch_id === I.branchA));
assertTrue("all alerts carry source ids", result.alerts.every((alert) => typeof alert.source_id === "string" && alert.source_id.length > 0));
assertTrue("no mutation authority advertised", result.limitations?.some((item) => /no business-state mutation/i.test(item)));

const zeroWindow = JSON.parse(asUser(I.managerA, `SELECT public.get_operational_alerts_v1('${I.branchA}','2026-09-12T12:00:00Z',0,0)::text`));
assertTrue("zero expiry horizon excludes future due lot", !zeroWindow.alerts.some((alert) => alert.source_id === I.dueLot));
assertTrue("zero cash lookback excludes earlier cash session", !zeroWindow.alerts.some((alert) => alert.source_id === I.recentCash));

expectReject("negative expiry horizon", I.managerA, `SELECT public.get_operational_alerts_v1('${I.branchA}','2026-09-12T12:00:00Z',-1,7)`, /between 0 and 365/i);
expectReject("expiry horizon above maximum", I.managerA, `SELECT public.get_operational_alerts_v1('${I.branchA}','2026-09-12T12:00:00Z',366,7)`, /between 0 and 365/i);
expectReject("negative cash lookback", I.managerA, `SELECT public.get_operational_alerts_v1('${I.branchA}','2026-09-12T12:00:00Z',7,-1)`, /between 0 and 365/i);
expectReject("cash lookback above maximum", I.managerA, `SELECT public.get_operational_alerts_v1('${I.branchA}','2026-09-12T12:00:00Z',7,366)`, /between 0 and 365/i);
expectReject("cross-tenant branch access", I.managerA, `SELECT public.get_operational_alerts_v1('${I.branchB}','2026-09-12T12:00:00Z',7,7)`);

process.stdout.write("Operational alerts v1 PostgreSQL contract PASS: deterministic inventory, expiry and exact-fils closed-session cash variance alerts; explicit bounded windows; provenance; branch isolation; and read-only authority verified.\n");
