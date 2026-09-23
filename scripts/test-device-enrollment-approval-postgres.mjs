import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable PostgreSQL contract database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = statement => execFileSync('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
  env: conn.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const tenant = 'a0000000-0000-0000-0000-000000000711';
const branch = 'b0000000-0000-0000-0000-000000000711';
const otherBranch = 'b0000000-0000-0000-0000-000000000712';
const manager = 'c0000000-0000-0000-0000-000000000711';
const cashier = 'c0000000-0000-0000-0000-000000000712';
const uid = 'SEC004-manager-approved-terminal';
const as = (actor, statement) => sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${actor}'; ${statement}; COMMIT;`);
const approve = (scope = branch, device = uid) => `SELECT public.approve_device_enrollment('${tenant}','${scope}','${device}')`;

sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 ('${manager}','device-manager@zaipos.test','{}'),('${cashier}','device-cashier@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES ('${tenant}','Enrollment Contract','enrollment-contract','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES
 ('${branch}','${tenant}','Enrollment A','active'),('${otherBranch}','${tenant}','Enrollment B','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
 ('${manager}','${tenant}','${branch}','manager'),('${cashier}','${tenant}','${branch}','cashier');`);
assert.throws(() => as(cashier, approve()), /authoriz|forbidden|permission/i,
  'Cashier must not approve enrollment even with a valid tenant and branch');
assert.equal(sql('SELECT count(*) FROM public.device_enrollment_approvals'), '0',
  'Denied cashier attempt must leave no approval');
assert.throws(() => as(manager, approve(otherBranch)), /authoriz|forbidden|permission/i,
  'Manager cannot approve a device for an unassigned branch');
const id = as(manager, approve());
assert.match(id, /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i);
assert.equal(sql(`SELECT tenant_id::text || '|' || branch_id::text || '|' || device_uid || '|' || approved_by::text || '|' || (consumed_at IS NULL)::text
 FROM public.device_enrollment_approvals WHERE id='${id}'::uuid`), `${tenant}|${branch}|${uid}|${manager}|true`);
assert.equal(sql(`SELECT count(*) FROM public.devices WHERE tenant_id='${tenant}' AND device_uid='${uid}'`), '0',
  'Approval alone must not create a trusted device or grant financial authority');
assert.throws(() => as(manager, approve()), /already|duplicate|unique|approval/i,
  'Repeated approval must not silently replace an outstanding enrollment');
assert.equal(sql(`SELECT count(*) FROM public.device_enrollment_approvals WHERE tenant_id='${tenant}'`), '1');
assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${tenant}' AND action='device.enrollment_approved' AND user_id='${manager}'`), '1');
console.log('PASS: manager-only scoped enrollment approval is auditable, single-use pending, and grants no device authority.');
