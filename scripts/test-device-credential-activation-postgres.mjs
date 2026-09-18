import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable PostgreSQL contract database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = statement => execFileSync('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
  env: conn.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const tenant = 'a0000000-0000-0000-0000-000000000721';
const branch = 'b0000000-0000-0000-0000-000000000721';
const manager = 'c0000000-0000-0000-0000-000000000721';
const uid = 'SEC004-credential-terminal';
const asManager = statement => sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${manager}'; ${statement}; COMMIT;`);

sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('${manager}','activation-manager@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES ('${tenant}','Activation Contract','activation-contract','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES ('${branch}','${tenant}','Activation A','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES ('${manager}','${tenant}','${branch}','manager');`);
const approval = asManager(`SELECT public.approve_device_enrollment('${tenant}','${branch}','${uid}')`);

assert.throws(() => asManager(`SELECT * FROM public.activate_device_enrollment('${approval}','1.0.0','windows')`),
  /permission|denied/i, 'Authenticated application roles must not activate credentials directly');

const activated = sql(`SET ROLE service_role; SELECT device_id::text || '|' || device_uid || '|' || credential FROM public.activate_device_enrollment('${approval}','1.0.0','windows'); RESET ROLE;`);
const [deviceId, returnedUid, credential] = activated.split('|');
assert.match(deviceId, /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i);
assert.equal(returnedUid, uid);
assert.match(credential, /^[a-f\d]{64}$/i, 'Activation must return 256 bits of server-generated credential entropy');
assert.equal(sql(`SELECT (credential_hash = digest('${credential}','sha256'))::text || '|' || (credential_issued_at IS NOT NULL)::text || '|' || (revoked_at IS NULL)::text FROM public.devices WHERE id='${deviceId}'`), 'true|true|true');
assert.equal(sql(`SELECT count(*) FROM public.devices WHERE credential_hash = decode('${credential}','hex')`), '0', 'Plaintext credential must never be persisted as the verifier');
assert.equal(sql(`SELECT (consumed_at IS NOT NULL)::text FROM public.device_enrollment_approvals WHERE id='${approval}'`), 'true');
assert.throws(() => sql(`SET ROLE service_role; SELECT * FROM public.activate_device_enrollment('${approval}','1.0.0','windows');`), /invalid|expired|consumed/i,
  'Consumed approval must be impossible to replay');
assert.equal(sql(`SELECT count(*) FROM public.devices WHERE tenant_id='${tenant}' AND device_uid='${uid}'`), '1');
assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${tenant}' AND action='device.enrollment_activated' AND metadata->>'device_id'='${deviceId}'`), '1');
console.log('PASS: activation is privileged, single-use, server-generated, verifier-only at rest, and audited.');
