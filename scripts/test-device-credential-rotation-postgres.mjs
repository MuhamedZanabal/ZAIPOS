import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable PostgreSQL contract database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = statement => {
  try {
    return execFileSync('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
      env: conn.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(String(error.stderr ?? error.message ?? error).trim());
  }
};
const tenant = 'a0000000-0000-0000-0000-000000000722';
const branch = 'b0000000-0000-0000-0000-000000000722';
const manager = 'c0000000-0000-0000-0000-000000000722';
const cashier = 'c0000000-0000-0000-0000-000000000723';
const uid = 'SEC004-rotation-terminal';
const asUser = (userId, statement) => sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`);

sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
  ('${manager}','rotation-manager@zaipos.test','{}'),
  ('${cashier}','rotation-cashier@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES ('${tenant}','Rotation Contract','rotation-contract','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES ('${branch}','${tenant}','Rotation A','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
  ('${manager}','${tenant}','${branch}','manager'),
  ('${cashier}','${tenant}','${branch}','cashier');`);

const enrollmentApproval = asUser(manager, `SELECT public.approve_device_enrollment('${tenant}','${branch}','${uid}')`);
const firstActivation = sql(`SET ROLE service_role; SELECT device_id::text || '|' || device_uid || '|' || credential FROM public.activate_device_enrollment('${enrollmentApproval}','1.0.0','windows'); RESET ROLE;`);
const [deviceId, activatedUid, firstCredential] = firstActivation.split('|');
assert.equal(activatedUid, uid);

assert.throws(
  () => asUser(cashier, `SELECT public.approve_device_credential_rotation('${tenant}','${deviceId}')`),
  /authoriz|permission|forbidden/i,
  'Cashiers must not approve credential rotation',
);
const rotationApproval = asUser(manager, `SELECT public.approve_device_credential_rotation('${tenant}','${deviceId}')`);
assert.match(rotationApproval, /^[a-f\d-]{36}$/i);

const rotated = sql(`SET ROLE service_role; SELECT device_id::text || '|' || device_uid || '|' || credential FROM public.rotate_device_credential('${rotationApproval}'); RESET ROLE;`);
const [rotatedDeviceId, rotatedUid, secondCredential] = rotated.split('|');
assert.equal(rotatedDeviceId, deviceId);
assert.equal(rotatedUid, uid);
assert.match(secondCredential, /^[a-f\d]{64}$/i);
assert.notEqual(secondCredential, firstCredential, 'Rotation must issue fresh credential entropy');
assert.equal(
  sql(`SELECT (credential_hash = digest('${secondCredential}','sha256'))::text || '|' || (credential_hash <> digest('${firstCredential}','sha256'))::text FROM public.devices WHERE id='${deviceId}'`),
  'true|true',
);

const heartbeat = credential => `SELECT public.register_device_heartbeat('${uid}','Rotation POS','${branch}','${credential}')`;
assert.throws(() => asUser(cashier, heartbeat(firstCredential)), /credential rejected|credential|authoriz|permission/i,
  'Old credential must fail immediately after rotation');
asUser(cashier, heartbeat(secondCredential));
assert.throws(() => sql(`SET ROLE service_role; SELECT * FROM public.rotate_device_credential('${rotationApproval}'); RESET ROLE;`), /invalid|expired|consumed/i,
  'Rotation approval must be single-use');
assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${tenant}' AND action='device.credential_rotated' AND entity_id='${deviceId}'`), '1');

asUser(manager, `SELECT public.revoke_device_enrollment('${tenant}','${deviceId}','rotation contract revocation')`);
assert.throws(
  () => asUser(manager, `SELECT public.approve_device_credential_rotation('${tenant}','${deviceId}')`),
  /revok|authoriz|invalid/i,
  'Revoked devices must not enter credential rotation',
);

console.log('PASS: credential rotation is manager-approved, single-use, audited, fresh, and invalidates the old credential.');
