import { execFileSync } from "node:child_process";
import { hashPosPin } from "../supabase/functions/_shared/pos-pin-crypto.ts";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
function scalar(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement], {
    encoding: "utf8",
  }).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}
function sql(statement) {
  execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: "inherit",
  });
}
function asRole(role, statement) {
  return scalar(`BEGIN; SET LOCAL ROLE ${role}; ${statement}; COMMIT;`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectReject(label, role, statement, pattern = /permission|forbidden|branch|device|session|authorized/i) {
  try {
    asRole(role, statement);
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

const requiredFunctions = [
  "public.set_employee_pos_pin_v1(uuid,uuid,uuid,uuid,text,text)",
  "public.begin_employee_pos_pin_verification_v1(uuid,uuid,uuid,uuid,text,uuid,text)",
  "public.complete_employee_pos_pin_verification_v1(uuid,uuid,boolean,text)",
];
for (const signature of requiredFunctions) {
  assertEqual(`required function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
  assertEqual(
    `authenticated cannot execute ${signature}`,
    scalar(`SELECT has_function_privilege('authenticated','${signature}','EXECUTE');`),
    "f",
  );
  assertEqual(
    `service role can execute ${signature}`,
    scalar(`SELECT has_function_privilege('service_role','${signature}','EXECUTE');`),
    "t",
  );
}

for (const table of ["employee_pos_credentials", "employee_pos_pin_attempts"]) {
  assertEqual(`required table ${table}`, scalar(`SELECT to_regclass('public.${table}') IS NOT NULL;`), "t");
  assertEqual(
    `authenticated cannot select ${table}`,
    scalar(`SELECT has_table_privilege('authenticated','public.${table}','SELECT');`),
    "f",
  );
  assertEqual(
    `authenticated cannot mutate ${table}`,
    scalar(`SELECT has_table_privilege('authenticated','public.${table}','INSERT,UPDATE,DELETE');`),
    "f",
  );
}

assertEqual("employees plaintext PIN removed", scalar("SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='employees' AND column_name='pin';"), "0");
assertEqual("profiles plaintext PIN removed", scalar("SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='pin';"), "0");
assertEqual("credential hash constrained to Argon2id", scalar("SELECT count(*)::text FROM pg_constraint WHERE conname='employee_pos_credentials_argon2id_check';"), "1");
assertEqual("attempt outcome is constrained", scalar("SELECT count(*)::text FROM pg_constraint WHERE conname='employee_pos_pin_attempts_outcome_check';"), "1");

const I = {
  tenantA: "15000000-0000-0000-0000-000000000101",
  tenantB: "15000000-0000-0000-0000-000000000102",
  branchA: "25000000-0000-0000-0000-000000000101",
  branchB: "25000000-0000-0000-0000-000000000102",
  managerA: "35000000-0000-0000-0000-000000000101",
  cashierA: "35000000-0000-0000-0000-000000000102",
  managerB: "35000000-0000-0000-0000-000000000103",
  employeeA: "55000000-0000-0000-0000-000000000101",
  legacyEmployee: "55000000-0000-0000-0000-000000000102",
  sessionA: "45000000-0000-0000-0000-000000000101",
  deviceA: "45000000-0000-0000-0000-000000000102",
};

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','pin-manager-a@zaipos.test','{}'),
    ('${I.cashierA}','pin-cashier-a@zaipos.test','{}'),
    ('${I.managerB}','pin-manager-b@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','PIN Tenant A','pin-tenant-a','BHD',10,false),
    ('${I.tenantB}','PIN Tenant B','pin-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','PIN Branch A','active'),
    ('${I.branchB}','${I.tenantB}','PIN Branch B','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}','${I.branchA}','manager'),
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.managerB}','${I.tenantB}','${I.branchB}','manager')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.employees(id,tenant_id,branch_id,full_name,role,status) VALUES
    ('${I.employeeA}','${I.tenantA}','${I.branchA}','PIN Cashier','cashier','active'),
    ('${I.legacyEmployee}','${I.tenantA}','${I.branchA}','Legacy Cashier','cashier','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.cash_sessions(id,tenant_id,branch_id,user_id,status)
  VALUES ('${I.sessionA}','${I.tenantA}','${I.branchA}','${I.cashierA}','open')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.devices(id,tenant_id,branch_id,device_uid,app_version,os)
  VALUES ('${I.deviceA}','${I.tenantA}','${I.branchA}','pos-pin-device-001','1.0.0','win32')
  ON CONFLICT (id) DO NOTHING;
`);

const hashA = await hashPosPin("4826", new Uint8Array(16).fill(9));
const hashB = await hashPosPin("7319", new Uint8Array(16).fill(10));
const setSql = (actor, employee, hash, operation) =>
  `SELECT public.set_employee_pos_pin_v1('${actor}'::uuid,'${I.tenantA}'::uuid,'${I.branchA}'::uuid,'${employee}'::uuid,'${hash}','${operation}')::text;`;

expectReject("authenticated cannot call set command", "authenticated", setSql(I.managerA, I.employeeA, hashA, "pin-set-operation-101"));
expectReject("cross-tenant manager cannot set PIN", "service_role", setSql(I.managerB, I.employeeA, hashA, "pin-set-operation-102"));
const credentialId = asRole("service_role", setSql(I.managerA, I.employeeA, hashA, "pin-set-operation-101"));
assertEqual("set PIN idempotent", asRole("service_role", setSql(I.managerA, I.employeeA, hashA, "pin-set-operation-101")), credentialId);
assertEqual("stored algorithm", scalar(`SELECT split_part(pin_hash,'$',2) FROM public.employee_pos_credentials WHERE id='${credentialId}'::uuid;`), "argon2id");
assertEqual("set audit exactly once", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='pos.pin_set' AND entity_id='${I.employeeA}'::uuid;`), "1");
expectReject("direct credential mutation locked down", "authenticated", `UPDATE public.employee_pos_credentials SET failed_attempts=0 WHERE id='${credentialId}'::uuid;`);

const beginSql = (operation, device = "pos-pin-device-001") =>
  `SELECT public.begin_employee_pos_pin_verification_v1('${I.cashierA}'::uuid,'${I.tenantA}'::uuid,'${I.branchA}'::uuid,'${I.employeeA}'::uuid,'${device}','${I.sessionA}'::uuid,'${operation}')::text;`;
expectReject("unregistered device denied", "service_role", beginSql("pin-attempt-bad-device", "unknown-device"));

for (let attempt = 1; attempt <= 5; attempt += 1) {
  const prepared = JSON.parse(asRole("service_role", beginSql(`pin-failed-attempt-${attempt}`)));
  assertEqual(`attempt ${attempt} allowed`, String(prepared.allowed), "true");
  const result = JSON.parse(asRole(
    "service_role",
    `SELECT public.complete_employee_pos_pin_verification_v1('${I.cashierA}'::uuid,'${prepared.attempt_id}'::uuid,false,NULL)::text;`,
  ));
  assertEqual(`attempt ${attempt} rejected`, String(result.verified), "false");
}
assertEqual("five failures lock credential", scalar(`SELECT locked_until > now() FROM public.employee_pos_credentials WHERE id='${credentialId}'::uuid;`), "t");
const locked = JSON.parse(asRole("service_role", beginSql("pin-locked-attempt-101")));
assertEqual("locked attempt fails closed", String(locked.allowed), "false");

asRole("service_role", setSql(I.managerA, I.employeeA, hashA, "pin-reset-operation-101"));
const preparedSuccess = JSON.parse(asRole("service_role", beginSql("pin-success-attempt-101")));
const success = JSON.parse(asRole(
  "service_role",
  `SELECT public.complete_employee_pos_pin_verification_v1('${I.cashierA}'::uuid,'${preparedSuccess.attempt_id}'::uuid,true,NULL)::text;`,
));
assertEqual("successful role resolution", success.role, "cashier");
assertEqual("successful employee resolution", success.employee_id, I.employeeA);
assertEqual("verification audit exactly once", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='pos.pin_verified' AND metadata->>'attempt_id'='${preparedSuccess.attempt_id}';`), "1");

const preparedBeforeReset = JSON.parse(asRole("service_role", beginSql("pin-stale-attempt-101")));
asRole("service_role", setSql(I.managerA, I.employeeA, hashB, "pin-version-change-101"));
expectReject(
  "PIN reset invalidates an in-flight verification",
  "service_role",
  `SELECT public.complete_employee_pos_pin_verification_v1('${I.cashierA}'::uuid,'${preparedBeforeReset.attempt_id}'::uuid,true,NULL);`,
  /stale|credential change/i,
);

sql(`INSERT INTO public.employee_pos_credentials(tenant_id,branch_id,employee_id,legacy_pin)
  VALUES ('${I.tenantA}','${I.branchA}','${I.legacyEmployee}','7319');`);
const legacyPrepared = JSON.parse(asRole(
  "service_role",
  `SELECT public.begin_employee_pos_pin_verification_v1('${I.cashierA}'::uuid,'${I.tenantA}'::uuid,'${I.branchA}'::uuid,'${I.legacyEmployee}'::uuid,'pos-pin-device-001','${I.sessionA}'::uuid,'pin-legacy-attempt-101')::text;`,
));
asRole(
  "service_role",
  `SELECT public.complete_employee_pos_pin_verification_v1('${I.cashierA}'::uuid,'${legacyPrepared.attempt_id}'::uuid,true,'${hashB}')::text;`,
);
assertEqual("legacy PIN cleared only after success", scalar(`SELECT legacy_pin IS NULL FROM public.employee_pos_credentials WHERE employee_id='${I.legacyEmployee}'::uuid;`), "t");
assertEqual("legacy PIN replaced with Argon2id", scalar(`SELECT pin_hash='${hashB}' FROM public.employee_pos_credentials WHERE employee_id='${I.legacyEmployee}'::uuid;`), "t");

process.stdout.write("POS PIN PASS: Argon2id-only credentials, authorization, device/session scope, five-attempt lockout, audit, legacy conversion and mutation lockdown hold.\n");
