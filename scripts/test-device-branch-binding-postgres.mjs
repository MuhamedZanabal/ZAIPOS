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

const sameBranchId = authenticated(heartbeat(firstBranch, '1.0.1'));
assert.equal(sameBranchId, id, 'Same-branch heartbeat must retain device identity');
assert.equal(sql(`SELECT branch_id::text || '|' || app_version FROM public.devices WHERE id='${id}'::uuid`),
  `${firstBranch}|1.0.1`, 'Same-branch heartbeat must update metadata without changing branch');

sql(`UPDATE public.devices SET revoked_at=now() WHERE id='${id}'::uuid`);
let revokedRejected = false;
try {
  authenticated(heartbeat(firstBranch, '9.9.9'));
} catch (error) {
  const text = String(error.stderr ?? error.message ?? error);
  if (!/revok/i.test(text)) throw error;
  revokedRejected = true;
}
assert.equal(revokedRejected, true, 'Revoked device must reject same-branch heartbeat');
assert.equal(sql(`SELECT branch_id::text || '|' || app_version || '|' || (revoked_at IS NOT NULL)::text
 FROM public.devices WHERE id='${id}'::uuid`), `${firstBranch}|1.0.1|true`,
'Revoked heartbeat must preserve branch, metadata and revocation');

// The pre-insert SELECT cannot lock an absent UID. A concurrent first registration
// can win the unique-index race after that SELECT, so the conflict path itself
// must recheck branch and revocation and turn a rejected conflict into an error.
const definition = sql(`SELECT pg_get_functiondef('public.register_device_heartbeat(uuid,uuid,text,text,text,text,text,jsonb)'::regprocedure)`);
assert.match(definition,
  /ON CONFLICT\s*\(tenant_id,\s*device_uid\)\s*DO UPDATE SET[\s\S]*?\bWHERE\s+(?:public\.)?devices\.branch_id\s*=\s*EXCLUDED\.branch_id\s+AND\s+(?:public\.)?devices\.revoked_at\s+IS NULL/i,
  'Concurrent first registration must enforce branch and revocation in the atomic conflict update');
assert.match(definition, /IF result\.id IS NULL THEN\s*RAISE EXCEPTION/i,
  'Rejected conflict must raise rather than return an empty successful heartbeat');
console.log('PASS: branch rebinding denied; same-branch refresh preserved; revoked heartbeat denied; atomic conflict authorization guarded.');
