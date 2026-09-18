import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('A disposable PostgreSQL contract database is required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = (statement) => execFileSync('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
  env: conn.env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const tenant = 'a0000000-0000-0000-0000-000000000702';
const firstBranch = 'b0000000-0000-0000-0000-000000000702';
const otherBranch = 'b0000000-0000-0000-0000-000000000703';
const cashier = 'c0000000-0000-0000-0000-000000000702';
const uid = 'SEC004-branch-bound-terminal';

sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('${cashier}','device-branch-binding@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES ('${tenant}','Device Branch Contract','device-branch-contract','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES
 ('${firstBranch}','${tenant}','Device Branch A','active'),
 ('${otherBranch}','${tenant}','Device Branch B','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
 ('${cashier}','${tenant}','${firstBranch}','cashier'),
 ('${cashier}','${tenant}','${otherBranch}','cashier');`);

const heartbeat = (branch, appVersion = '1.0.0') => `SELECT (public.register_device_heartbeat(
 '${tenant}', '${branch}', '${uid}', '${appVersion}', 'win32', 'stable', 'current', '{}'::jsonb
)).id`;
const authenticated = (statement) => sql(`BEGIN; SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='${cashier}'; ${statement}; COMMIT;`);
const id = authenticated(heartbeat(firstBranch));
assert.match(id, /^[a-f\d-]{36}$/i, 'initial scoped heartbeat must register a device');

let rejected = false;
try {
  authenticated(heartbeat(otherBranch, '9.9.9'));
} catch (error) {
  const text = String(error.stderr ?? error.message ?? error);
  if (!/device|branch|re.enroll|authoriz|permission|bound/i.test(text)) throw error;
  rejected = true;
}
const record = sql(`SELECT branch_id::text || '|' || app_version
 FROM public.devices WHERE id='${id}'::uuid`);
assert.equal(rejected, true, 'A cashier assigned to two branches must not rebind an existing device UID by heartbeat');
assert.equal(record, `${firstBranch}|1.0.0`, 'Rejected rebinding must preserve both original branch and heartbeat metadata');
console.log('PASS: authenticated heartbeat cannot rebind an existing device across branches or mutate its metadata.');
