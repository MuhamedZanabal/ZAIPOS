import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable contract database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = (statement, stage = 'PostgreSQL fixture command') => {
  try {
    return execFileSync('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
      env: conn.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim();
    throw new Error(`${stage} failed: ${stderr || 'PostgreSQL command failed without stderr'}`);
  }
};
const mark = stage => console.log(`SEC004_SUPPLIER_PAYMENT_STAGE ${stage}`);

const tenant = 'aa000000-0000-0000-0000-000000000901';
const branch = 'bb000000-0000-0000-0000-000000000901';
const otherBranch = 'bb000000-0000-0000-0000-000000000902';
const manager = 'cc000000-0000-0000-0000-000000000901';
const cashier = 'cc000000-0000-0000-0000-000000000902';
const supplier = 'dd000000-0000-0000-0000-000000000901';
const deviceUid = 'SEC004-supplier-payment-terminal';
const copiedUid = 'SEC004-copied-supplier-terminal';

const authAs = (user, statement, stage) => sql(
  `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${user}'; ${statement}; COMMIT;`,
  stage,
);

mark('fixture');
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
  ('${manager}','sec004-supplier-manager@zaipos.test','{}'),
  ('${cashier}','sec004-supplier-cashier@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES('${tenant}','Supplier Device','supplier-device-contract','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES
  ('${branch}','${tenant}','Supplier Device','active'),
  ('${otherBranch}','${tenant}','Other Supplier Device','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
  ('${manager}','${tenant}','${branch}','manager'),
  ('${cashier}','${tenant}','${branch}','cashier');
INSERT INTO public.suppliers(id,tenant_id,name,status) VALUES('${supplier}','${tenant}','Supplier Device Vendor','active');
INSERT INTO public.supplier_subledger_cutovers(tenant_id,branch_id,activated_at) VALUES
  ('${tenant}','${branch}',now() - interval '1 day'),
  ('${tenant}','${otherBranch}',now() - interval '1 day');`, 'fixture');

authAs(manager, `SELECT public.set_supplier_opening_balance_v1('${tenant}','${branch}','${supplier}',2000,'Verified opening','supplier-opening-device-001')`, 'opening balance');

const approval = authAs(manager, `SELECT public.approve_device_enrollment('${tenant}','${branch}','${deviceUid}')`, 'manager approval');
const activated = sql(`SET ROLE service_role; SELECT device_id::text || '|' || device_uid || '|' || credential FROM public.activate_device_enrollment('${approval}','1.0.0','windows'); RESET ROLE;`, 'credential activation');
const [device, activatedUid, credential] = activated.split('|');
assert.equal(activatedUid, deviceUid);
assert.match(credential, /^[a-f\d]{64}$/i);

const payment = (uid, secret, operation = 'supplier-payment-device-001', branchId = branch, amount = 500) =>
  `SELECT public.record_supplier_payment_v2_device('${tenant}','${branchId}','${supplier}',${amount},'bank_transfer','BANK-REF-DEVICE','Part payment','${operation}','${uid}','${secret}')`;
const snapshot = stage => sql(
  `SELECT (SELECT COALESCE(sum(amount_fils),0)::text FROM public.supplier_ledger_entries WHERE supplier_id='${supplier}' AND entry_type='payment')
    || '|' || (SELECT count(*)::text FROM public.supplier_ledger_entries WHERE supplier_id='${supplier}' AND entry_type='payment')
    || '|' || (SELECT count(*)::text FROM public.supplier_financial_operations WHERE supplier_id='${supplier}' AND operation_kind='payment')
    || '|' || (SELECT count(*)::text FROM public.audit_logs WHERE tenant_id='${tenant}' AND action='supplier.payment_recorded')`,
  stage,
);

const baseline = snapshot('denial baseline');
assert.equal(baseline, '0|0|0|0');
mark('legacy-rejection');
assert.throws(
  () => authAs(manager, `SELECT public.record_supplier_payment_v1('${tenant}','${branch}','${supplier}',500,'bank_transfer','BANK-REF-LEGACY','legacy','supplier-payment-legacy-001')`, 'legacy payment'),
  /permission denied|not authorized|forbidden/i,
);
for (const [name, statement] of [
  ['missing credential', payment(deviceUid, '')],
  ['copied credential', payment(copiedUid, credential)],
  ['wrong branch', payment(deviceUid, credential, 'supplier-payment-wrong-branch', otherBranch)],
]) {
  mark(name.replaceAll(' ', '-'));
  assert.throws(() => authAs(manager, statement, name), /device credential|required|scope|authoriz|permission/i, name);
}
assert.equal(snapshot('denied zero-effect check'), baseline, 'Denied supplier payments must have zero ledger, operation, or audit effects');

mark('cashier-role');
assert.throws(
  () => authAs(cashier, payment(deviceUid, credential, 'supplier-payment-cashier-001'), 'cashier payment'),
  /forbidden|authoriz|permission|role/i,
);
assert.equal(snapshot('cashier zero-effect check'), baseline, 'Cashier supplier payments must remain zero-effect even with a valid device');

mark('credential-payment');
const entry = authAs(manager, payment(deviceUid, credential), 'credential payment');
assert.match(entry, /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i);
assert.equal(authAs(manager, payment(deviceUid, credential), 'credential payment replay'), entry);
assert.equal(snapshot('committed exactly-once check'), '500|1|1|1');
assert.throws(
  () => authAs(manager, payment(deviceUid, credential, 'supplier-payment-device-001', branch, 600), 'payload conflict'),
  /different input|operation|supplier/i,
);
assert.equal(snapshot('conflict zero-effect check'), '500|1|1|1');

mark('revocation');
assert.equal(authAs(manager, `SELECT public.revoke_device_enrollment('${tenant}','${device}','security incident')`, 'device revocation'), 't');
for (const [name, statement] of [
  ['replay after revocation', payment(deviceUid, credential)],
  ['new payment after revocation', payment(deviceUid, credential, 'supplier-payment-after-revoke')],
]) {
  assert.throws(() => authAs(manager, statement, name), /device credential|revok|authoriz|permission/i, name);
}
assert.equal(snapshot('revoked zero-effect check'), '500|1|1|1');

console.log('SEC004_SUPPLIER_PAYMENT ' + JSON.stringify({
  legacyBypassRejected: true,
  missingCredentialRejected: true,
  copiedCredentialRejected: true,
  wrongBranchRejected: true,
  cashierRolePreserved: true,
  paymentExactlyOnce: true,
  payloadConflictRejected: true,
  revokedReplayRejected: true,
  zeroRejectedEffects: true,
}));
console.log('PASS: supplier payments require native device authority before replay or financial effect.');
