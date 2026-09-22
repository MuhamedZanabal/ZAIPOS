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
const mark = stage => console.log(`SEC004_CUSTOMER_CREDIT_STAGE ${stage}`);

const tenant = 'aa000000-0000-0000-0000-000000000801';
const branch = 'bb000000-0000-0000-0000-000000000801';
const otherBranch = 'bb000000-0000-0000-0000-000000000802';
const manager = 'cc000000-0000-0000-0000-000000000801';
const cashier = 'cc000000-0000-0000-0000-000000000802';
const customer = 'dd000000-0000-0000-0000-000000000801';
const deviceUid = 'SEC004-customer-credit-terminal';
const copiedUid = 'SEC004-copied-credit-terminal';

const authAs = (user, statement, stage) => sql(
  `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${user}'; ${statement}; COMMIT;`,
  stage,
);

mark('fixture');
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
  ('${manager}','sec004-credit-manager@zaipos.test','{}'),
  ('${cashier}','sec004-credit-cashier@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES('${tenant}','Credit Device','credit-device-contract','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES
  ('${branch}','${tenant}','Credit Device','active'),
  ('${otherBranch}','${tenant}','Other Credit Device','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
  ('${manager}','${tenant}','${branch}','manager'),
  ('${cashier}','${tenant}','${branch}','cashier');
INSERT INTO public.profiles(id,email,default_tenant_id) VALUES
  ('${manager}','sec004-credit-manager@zaipos.test','${tenant}'),
  ('${cashier}','sec004-credit-cashier@zaipos.test','${tenant}');
INSERT INTO public.customers(id,tenant_id,name,status) VALUES('${customer}','${tenant}','Credit Device Customer','active');`, 'fixture');

authAs(manager, `SELECT public.set_customer_credit_limit_v1('${customer}',5000,'Approved limit','credit-limit-device-001')`, 'credit limit');
authAs(manager, `SELECT public.set_customer_credit_opening_balance_v1('${customer}',2000,'Verified opening','credit-opening-device-001')`, 'opening balance');

const approval = authAs(manager, `SELECT public.approve_device_enrollment('${tenant}','${branch}','${deviceUid}')`, 'manager approval');
const activated = sql(`SET ROLE service_role; SELECT device_id::text || '|' || device_uid || '|' || credential FROM public.activate_device_enrollment('${approval}','1.0.0','windows'); RESET ROLE;`, 'credential activation');
const [device, activatedUid, credential] = activated.split('|');
assert.equal(activatedUid, deviceUid);
assert.match(credential, /^[a-f\d]{64}$/i);

const payment = (uid, secret, operation = 'credit-payment-device-001', branchId = branch, amount = 500) =>
  `SELECT public.record_customer_credit_payment_v2_device('${tenant}','${branchId}','${customer}',${amount},'cash','receipt-device-001','${operation}','${uid}','${secret}')`;
const snapshot = stage => sql(
  `SELECT (SELECT balance_fils::text FROM public.customer_credit_accounts WHERE customer_id='${customer}')
    || '|' || (SELECT count(*)::text FROM public.customer_credit_entries WHERE customer_id='${customer}' AND entry_type='payment')
    || '|' || (SELECT count(*)::text FROM public.customer_credit_operations WHERE customer_id='${customer}' AND command='payment')
    || '|' || (SELECT count(*)::text FROM public.audit_logs WHERE tenant_id='${tenant}' AND action='customer.credit_payment_recorded')`,
  stage,
);

const baseline = snapshot('denial baseline');
assert.equal(baseline, '2000|0|0|0');
mark('legacy-rejection');
assert.throws(
  () => authAs(cashier, `SELECT public.record_customer_credit_payment_v1('${customer}',500,'cash','legacy-receipt','credit-payment-legacy-001')`, 'legacy payment'),
  /permission denied|not authorized|forbidden/i,
);
for (const [name, statement] of [
  ['missing credential', payment(deviceUid, '')],
  ['copied credential', payment(copiedUid, credential)],
  ['wrong branch', payment(deviceUid, credential, 'credit-payment-wrong-branch', otherBranch)],
]) {
  mark(name.replaceAll(' ', '-'));
  assert.throws(() => authAs(cashier, statement, name), /device credential|required|scope|authoriz|permission/i, name);
}
assert.equal(snapshot('denied zero-effect check'), baseline, 'Denied credit payments must have zero balance, entry, operation, or audit effects');

mark('credential-payment');
const entry = authAs(cashier, payment(deviceUid, credential), 'credential payment');
assert.match(entry, /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i);
assert.equal(authAs(cashier, payment(deviceUid, credential), 'credential payment replay'), entry);
assert.equal(snapshot('committed exactly-once check'), '1500|1|1|1');
assert.throws(
  () => authAs(cashier, payment(deviceUid, credential, 'credit-payment-device-001', branch, 600), 'payload conflict'),
  /different payload|operation|credit/i,
);
assert.equal(snapshot('conflict zero-effect check'), '1500|1|1|1');

mark('revocation');
assert.equal(authAs(manager, `SELECT public.revoke_device_enrollment('${tenant}','${device}','security incident')`, 'device revocation'), 't');
for (const [name, statement] of [
  ['replay after revocation', payment(deviceUid, credential)],
  ['new payment after revocation', payment(deviceUid, credential, 'credit-payment-after-revoke')],
]) {
  assert.throws(() => authAs(cashier, statement, name), /device credential|revok|authoriz|permission/i, name);
}
assert.equal(snapshot('revoked zero-effect check'), '1500|1|1|1');

console.log('SEC004_CUSTOMER_CREDIT ' + JSON.stringify({ legacyBypassRejected: true, missingCredentialRejected: true, copiedCredentialRejected: true, wrongBranchRejected: true, paymentExactlyOnce: true, payloadConflictRejected: true, revokedReplayRejected: true, zeroRejectedEffects: true }));
console.log('PASS: customer-credit payments require native device authority before replay or financial effect.');
