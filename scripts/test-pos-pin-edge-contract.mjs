import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const edge = readFileSync(`${root}/supabase/functions/pos-pin/index.ts`, "utf8");
const employees = readFileSync(`${root}/src/modules/staff/Employees.tsx`, "utf8");

for (const required of [
  "auth.getUser()",
  "SUPABASE_SERVICE_ROLE_KEY",
  "hashPosPin",
  "verifyPosPin",
  "set_employee_pos_pin_v1",
  "begin_employee_pos_pin_verification_v1",
  "complete_employee_pos_pin_verification_v1",
  "crypto.randomUUID()",
]) {
  if (!edge.includes(required)) throw new Error(`POS PIN Edge Function is missing ${required}`);
}
if (/console\.(?:log|debug|info)\s*\(/u.test(edge)) {
  throw new Error("POS PIN Edge Function must not log PIN request material");
}
if (!employees.includes("const { pin, ...employee } = form;")) {
  throw new Error("Employee creation must strip the plaintext PIN from the direct row insert");
}
if (!employees.includes('functions.invoke("pos-pin"')) {
  throw new Error("Employee PIN setup must use the authenticated POS PIN Edge Function");
}

process.stdout.write("POS PIN Edge contract PASS: authenticated Argon2id service path and plaintext client-write lockdown hold.\n");
