import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
function scalar(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement], {
    encoding: "utf8",
  }).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

process.stdout.write("POS PIN schema PASS: Argon2id-only credentials, service-only commands, attempt ledger and plaintext lockdown hold.\n");
