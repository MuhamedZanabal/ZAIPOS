// Discount approval threshold: cashiers up to the tenant limit (default 10%),
// above it only managers or a fresh manager POS-PIN verification by the same caller.
import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const scalar = (statement) =>
  execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement], { encoding: "utf8" })
    .trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
const asService = (statement) => scalar(`BEGIN; SET LOCAL ROLE service_role; ${statement}; COMMIT;`);
const eq = (label, actual, expected) => {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`ok - ${label}`);
};

const I = {
  tenant: "16000000-0000-0000-0000-000000000101",
  branch: "26000000-0000-0000-0000-000000000101",
  managerUser: "36000000-0000-0000-0000-000000000101",
  cashierUser: "36000000-0000-0000-0000-000000000102",
  managerEmp: "56000000-0000-0000-0000-000000000101",
  cashierEmp: "56000000-0000-0000-0000-000000000102",
  session: "46000000-0000-0000-0000-000000000101",
  device: "46000000-0000-0000-0000-000000000102",
};
const HASH = "$argon2id$v=19$m=19456,t=2,p=1$CQkJCQkJCQkJCQkJCQkJCQ$0000000000000000000000000000000000000000000";

scalar(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerUser}','disc-manager@zaipos.test','{}'),('${I.cashierUser}','disc-cashier@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode)
    VALUES ('${I.tenant}','Discount Tenant','discount-tenant','BHD',10,false) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES ('${I.branch}','${I.tenant}','Discount Branch','active') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerUser}','${I.tenant}','${I.branch}','manager'),('${I.cashierUser}','${I.tenant}','${I.branch}','cashier')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.employees(id,tenant_id,branch_id,full_name,role,status) VALUES
    ('${I.managerEmp}','${I.tenant}','${I.branch}','Floor Manager','manager','active'),
    ('${I.cashierEmp}','${I.tenant}','${I.branch}','Till Cashier','cashier','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.cash_sessions(id,tenant_id,branch_id,user_id,status)
    VALUES ('${I.session}','${I.tenant}','${I.branch}','${I.cashierUser}','open') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.devices(id,tenant_id,branch_id,device_uid,app_version,os)
    VALUES ('${I.device}','${I.tenant}','${I.branch}','discount-device-001','1.0.0','win32') ON CONFLICT (id) DO NOTHING;
  SELECT 1`);

eq("tenant threshold defaults to 10%", scalar(`SELECT discount_approval_threshold_pct::text FROM public.tenants WHERE id='${I.tenant}'`), "10.00");
eq("threshold range enforced", scalar(`SELECT count(*)::text FROM pg_constraint WHERE conname='tenants_discount_threshold_range'`), "1");
const sig = "public.line_discount_authorized_v1(uuid,uuid,uuid,bigint,bigint,text)";
eq("authenticated cannot call the helper", scalar(`SELECT has_function_privilege('authenticated','${sig}','EXECUTE')`), "f");
eq("checkout uses the helper", scalar(`SELECT (prosrc LIKE '%line_discount_authorized_v1%')::text FROM pg_proc WHERE oid='public.checkout_sale_v2(uuid,uuid,jsonb,jsonb,bigint,text,uuid,public.sales_channel,bigint,text,text,uuid)'::regprocedure`), "true");

const ok = (user, discount, gross, op = null) =>
  scalar(`SELECT public.line_discount_authorized_v1('${user}','${I.tenant}','${I.branch}',${discount},${gross},${op ? `'${op}'` : "NULL"})::text`);

eq("cashier may discount exactly 10%", ok(I.cashierUser, 1000, 10000), "true");
eq("cashier 1 fil rounding tolerance", ok(I.cashierUser, 1001, 10000), "true");
eq("cashier above 10% is refused", ok(I.cashierUser, 1500, 10000), "false");
eq("manager session may exceed the threshold", ok(I.managerUser, 5000, 10000), "true");

const verify = (employee, operation) => {
  for (const [emp, op] of [[employee, operation]]) {
    asService(`SELECT public.set_employee_pos_pin_v1('${I.managerUser}','${I.tenant}','${I.branch}','${emp}','${HASH}','set-${op}')::text`);
    const begin = JSON.parse(asService(`SELECT public.begin_employee_pos_pin_verification_v1('${I.cashierUser}','${I.tenant}','${I.branch}','${emp}','discount-device-001','${I.session}','${op}')::text`));
    asService(`SELECT public.complete_employee_pos_pin_verification_v1('${I.cashierUser}','${begin.attempt_id}',true,NULL)::text`);
  }
  return operation;
};
const managerOp = verify(I.managerEmp, "disc-approval-manager-1");
const cashierOp = verify(I.cashierEmp, "disc-approval-cashier-1");
eq("manager PIN verification approves above threshold", ok(I.cashierUser, 5000, 10000, managerOp), "true");
eq("a cashier's own PIN does not approve", ok(I.cashierUser, 5000, 10000, cashierOp), "false");
eq("approval is bound to the caller", ok(I.managerUser.replace(/1$/, "9"), 5000, 10000, managerOp), "false");
eq("unknown approval id refused", ok(I.cashierUser, 5000, 10000, "nope"), "false");
scalar(`UPDATE public.employee_pos_pin_attempts SET completed_at = now() - interval '11 minutes' WHERE operation_id='${managerOp}'`);
eq("stale approval refused", ok(I.cashierUser, 5000, 10000, managerOp), "false");

scalar(`UPDATE public.tenants SET discount_approval_threshold_pct = 20 WHERE id='${I.tenant}'`);
eq("raised tenant threshold applies", ok(I.cashierUser, 1500, 10000), "true");
let rejected = false;
try { scalar(`UPDATE public.tenants SET discount_approval_threshold_pct = 120 WHERE id='${I.tenant}'`); } catch { rejected = true; }
eq("threshold above 100% rejected", String(rejected), "true");
console.log("discount threshold contract: PASS");
