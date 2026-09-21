import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const IDS = {
  tenant: "11000000-0000-0000-0000-000000000099",
  branch: "21000000-0000-0000-0000-000000000099",
  branch2: "21000000-0000-0000-0000-000000000098",
  tenant2: "11000000-0000-0000-0000-000000000098",
  tenant2Branch: "21000000-0000-0000-0000-000000000097",
  cashier: "31000000-0000-0000-0000-000000000099",
  session: "41000000-0000-0000-0000-000000000099",
  center: "46000000-0000-0000-0000-000000000099",
  product: "51000000-0000-0000-0000-000000000099",
  device: "61000000-0000-0000-0000-000000000099",
  device2: "61000000-0000-0000-0000-000000000098",
  tenant2Device: "61000000-0000-0000-0000-000000000097",
  lease: "71000000-0000-0000-0000-000000000099",
  expiredLease: "71000000-0000-0000-0000-000000000098",
  mutation: "81000000-0000-0000-0000-000000000099",
};
const TOKEN = "a".repeat(64);
const BAD_TOKEN = "b".repeat(64);
const items = [{ product_id: IDS.product, quantity: "1.000", discount_fils: 0 }];
const payments = [{ method: "cash", amount_fils: 1000, reference: null }];

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}
function sql(statement) { return psql(["-c", statement], false); }
function scalar(statement) { return psql(["-At", "-c", statement]).trim(); }
function q(value) { return String(value).replaceAll("'", "''"); }
function reconcile({ mutation = IDS.mutation, token = TOKEN, tenant = IDS.tenant, branch = IDS.branch, lease = IDS.lease, uid = "terminal-offline-01", requestItems = items } = {}) {
  return scalar(`SET request.jwt.claim.sub='${IDS.cashier}'; SELECT public.reconcile_offline_checkout('${tenant}'::uuid,'${branch}'::uuid,'${lease}'::uuid,'${token}','${uid}','${mutation}'::uuid,'${q(JSON.stringify(requestItems))}'::jsonb,'${q(JSON.stringify(payments))}'::jsonb,0,NULL,NULL::uuid,'pos'::public.sales_channel,0,NULL,'${IDS.session}'::uuid);`);
}
function expectFailure(label, fn, pattern) {
  try { fn(); } catch (error) {
    const text = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(text)) throw new Error(`${label}: wrong rejection: ${text}`);
    return;
  }
  throw new Error(`${label}: unexpectedly succeeded`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function snapshot() {
  return scalar(`SELECT concat_ws('|',(SELECT count(*) FROM public.sales WHERE tenant_id='${IDS.tenant}'),(SELECT count(*) FROM public.payments p JOIN public.sales s ON s.id=p.sale_id WHERE s.tenant_id='${IDS.tenant}'),(SELECT count(*) FROM public.inventory_movements WHERE tenant_id='${IDS.tenant}' AND movement_type='sale'),(SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${IDS.center}' AND product_id='${IDS.product}'),(SELECT total_cash_fils::text FROM public.cash_sessions WHERE id='${IDS.session}'),(SELECT count(*) FROM public.offline_checkout_reconciliations WHERE tenant_id='${IDS.tenant}'));`);
}

sql(`
  DELETE FROM public.offline_checkout_reconciliations WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.device_offline_leases WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.devices WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.checkout_operations WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.audit_logs WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.inventory_movements WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.payments WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.sale_items WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.sales WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.inventory_stocks WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.cash_sessions WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.user_roles WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.inventory_centers WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.products WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.branches WHERE tenant_id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM public.tenants WHERE id IN ('${IDS.tenant}'::uuid,'${IDS.tenant2}'::uuid);
  DELETE FROM auth.users WHERE id='${IDS.cashier}'::uuid;
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('${IDS.cashier}','offline-reconcile@zaipos.test','{"full_name":"Offline Reconcile Cashier"}');
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock) VALUES
    ('${IDS.tenant}','Offline Reconcile Tenant','offline-reconcile-tenant','BHD',10,false,false),
    ('${IDS.tenant2}','Foreign Tenant','offline-reconcile-foreign','BHD',10,false,false);
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${IDS.branch}','${IDS.tenant}','Offline Branch','active'),
    ('${IDS.branch2}','${IDS.tenant}','Other Branch','active'),
    ('${IDS.tenant2Branch}','${IDS.tenant2}','Foreign Branch','active');
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES ('${IDS.cashier}','${IDS.tenant}','${IDS.branch}','cashier');
  INSERT INTO public.cash_sessions(id,tenant_id,branch_id,user_id,status) VALUES ('${IDS.session}','${IDS.tenant}','${IDS.branch}','${IDS.cashier}','open');
  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES ('${IDS.center}','${IDS.tenant}','${IDS.branch}','Offline POS','point_of_sale','active');
  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status) VALUES ('${IDS.product}','${IDS.tenant}','Offline Product','simple',1.000,0.500,0,'active');
  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES ('${IDS.tenant}','${IDS.branch}','${IDS.center}','${IDS.product}',10.000);
  INSERT INTO public.devices(id,tenant_id,branch_id,device_uid,app_version,os) VALUES
    ('${IDS.device}','${IDS.tenant}','${IDS.branch}','terminal-offline-01','1.0.0','windows'),
    ('${IDS.device2}','${IDS.tenant}','${IDS.branch2}','terminal-offline-02','1.0.0','windows'),
    ('${IDS.tenant2Device}','${IDS.tenant2}','${IDS.tenant2Branch}','terminal-offline-03','1.0.0','windows');
  INSERT INTO public.device_offline_leases(id,tenant_id,branch_id,device_id,lease_hash,issued_to,issued_at,expires_at)
  VALUES ('${IDS.lease}','${IDS.tenant}','${IDS.branch}','${IDS.device}',extensions.digest(convert_to('${TOKEN}','UTF8'),'sha256'),'${IDS.cashier}',clock_timestamp(),clock_timestamp()+interval '15 minutes');
`);

const saleId = reconcile();
if (!/^[0-9a-f-]{36}$/i.test(saleId)) throw new Error(`valid reconciliation did not return sale UUID: ${saleId}`);
assertEqual("valid sale count", scalar(`SELECT count(*)::text FROM public.sales WHERE tenant_id='${IDS.tenant}' AND client_mutation_id='${IDS.mutation}';`), "1");
assertEqual("valid exact BHD cash fils", scalar(`SELECT total_cash_fils::text FROM public.cash_sessions WHERE id='${IDS.session}';`), "1000");
assertEqual("valid stock", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${IDS.center}' AND product_id='${IDS.product}';`), "9.000");
assertEqual("valid reconciliation completed", scalar(`SELECT status||':'||(sale_id='${saleId}'::uuid)::text FROM public.offline_checkout_reconciliations WHERE mutation_id='${IDS.mutation}';`), "completed:true");

// Lost-response replay: same immutable mutation returns the original result with zero new side effects.
const afterValid = snapshot();
assertEqual("exact replay sale", reconcile(), saleId);
assertEqual("exact replay side effects", snapshot(), afterValid);

// Mutation UUID cannot be rebound to altered financial content.
expectFailure("altered payload replay", () => reconcile({ requestItems: [{ product_id: IDS.product, quantity: "2.000", discount_fils: 0 }] }), /different authority or payload/i);
assertEqual("altered payload zero side effects", snapshot(), afterValid);

// Capability possession and immutable scope are independently enforced.
expectFailure("wrong capability", () => reconcile({ mutation: "81000000-0000-0000-0000-000000000098", token: BAD_TOKEN }), /offline lease rejected/i);
assertEqual("wrong capability zero side effects", snapshot(), afterValid);
expectFailure("cross-device", () => reconcile({ mutation: "81000000-0000-0000-0000-000000000097", uid: "terminal-offline-02" }), /device rejected|lease rejected/i);
assertEqual("cross-device zero side effects", snapshot(), afterValid);
expectFailure("cross-branch", () => reconcile({ mutation: "81000000-0000-0000-0000-000000000096", branch: IDS.branch2, uid: "terminal-offline-02" }), /lease rejected/i);
assertEqual("cross-branch zero side effects", snapshot(), afterValid);
expectFailure("cross-tenant", () => reconcile({ mutation: "81000000-0000-0000-0000-000000000095", tenant: IDS.tenant2, branch: IDS.tenant2Branch, uid: "terminal-offline-03" }), /lease rejected/i);
assertEqual("cross-tenant zero side effects", snapshot(), afterValid);

// Revocation invalidates the previously valid plaintext capability immediately.
sql(`UPDATE public.device_offline_leases SET revoked_at=clock_timestamp(), revoke_reason='adversarial-test' WHERE id='${IDS.lease}';`);
expectFailure("revoked lease", () => reconcile({ mutation: "81000000-0000-0000-0000-000000000094" }), /offline lease rejected/i);
assertEqual("revoked lease zero side effects", snapshot(), afterValid);

// An otherwise well-formed capability is unusable after its bounded authority expires.
sql(`INSERT INTO public.device_offline_leases(id,tenant_id,branch_id,device_id,lease_hash,issued_to,issued_at,expires_at) VALUES ('${IDS.expiredLease}','${IDS.tenant}','${IDS.branch}','${IDS.device}',extensions.digest(convert_to('${TOKEN}','UTF8'),'sha256'),'${IDS.cashier}',clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '1 minute');`);
expectFailure("expired lease", () => reconcile({ mutation: "81000000-0000-0000-0000-000000000093", lease: IDS.expiredLease }), /offline lease rejected/i);
assertEqual("expired lease zero side effects", snapshot(), afterValid);

process.stdout.write("Offline checkout reconciliation PostgreSQL PASS: exact replay converges and altered payload, wrong capability, revoked/expired lease, cross-device, cross-branch and cross-tenant attempts are fail-closed with zero financial side effects.\n");
