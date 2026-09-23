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
const mark = stage => console.log(`SEC004_STAGE ${stage}`);

const tenant = 'aa000000-0000-0000-0000-000000000601';
const branch = 'bb000000-0000-0000-0000-000000000601';
const otherBranch = 'bb000000-0000-0000-0000-000000000602';
const actor = 'cc000000-0000-0000-0000-000000000601';
const manager = 'cc000000-0000-0000-0000-000000000602';
const session = 'dd000000-0000-0000-0000-000000000601';
const center = 'ee000000-0000-0000-0000-000000000601';
const product = 'ff000000-0000-0000-0000-000000000601';
const original = 'SEC004-original-terminal';
const replacement = 'SEC004-copied-renderer-new-uid';
const actorEmail = 'sec004-device-boundary@zaipos.test';
const managerEmail = 'sec004-device-manager@zaipos.test';

mark('fixture');
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
  ('${actor}','${actorEmail}','{}'),
  ('${manager}','${managerEmail}','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock) VALUES('${tenant}','Device Boundary','device-boundary-contract','BHD',10,false,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES
  ('${branch}','${tenant}','Device Boundary','active'),
  ('${otherBranch}','${tenant}','Other Device Boundary','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
  ('${actor}','${tenant}','${branch}','cashier'),
  ('${actor}','${tenant}','${otherBranch}','cashier'),
  ('${manager}','${tenant}','${branch}','manager');
INSERT INTO public.cash_sessions(id,tenant_id,branch_id,user_id,status) VALUES('${session}','${tenant}','${branch}','${actor}','open');
INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES('${center}','${tenant}','${branch}','Device POS','point_of_sale','active');
INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status) VALUES('${product}','${tenant}','Device Test Product','simple',1.000,0.500,0,'active');
INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES('${tenant}','${branch}','${center}','${product}',2.000);`, 'fixture');

const authAs = (userId, statement, stage) => sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`, stage);
mark('approval');
const approval = authAs(manager, `SELECT public.approve_device_enrollment('${tenant}','${branch}','${original}')`, 'manager approval');
mark('activation');
const activated = sql(`SET ROLE service_role; SELECT device_id::text || '|' || device_uid || '|' || credential FROM public.activate_device_enrollment('${approval}','1.0.0','windows'); RESET ROLE;`, 'credential activation');
const [device, activatedUid, credential] = activated.split('|');
assert.equal(activatedUid, original);
assert.match(credential, /^[a-f\d]{64}$/i);

const heartbeat = (uid, secret) => `SELECT public.register_device_heartbeat('${uid}','Device POS','${branch}','${secret}')`;
mark('credential-heartbeat');
authAs(actor, heartbeat(original, credential), 'credential heartbeat');
const acceptedHeartbeatAt = sql(`SELECT last_seen_at::text FROM public.devices WHERE id='${device}'`, 'accepted heartbeat timestamp');
mark('cross-branch-heartbeat-rejection');
assert.throws(
  () => authAs(actor, heartbeat(original, credential).replace(`'${branch}'`, `'${otherBranch}'`), 'cross-branch credential heartbeat'),
  /device credential rejected|branch|device|authoriz|permission/i,
  'An operator assigned to both branches must not rebind an enrolled credential by heartbeat',
);
assert.equal(
  sql(`SELECT branch_id::text || '|' || last_seen_at::text FROM public.devices WHERE id='${device}'`, 'cross-branch heartbeat persistence check'),
  `${branch}|${acceptedHeartbeatAt}`,
  'Rejected cross-branch heartbeat must preserve enrollment and heartbeat evidence',
);

const items = JSON.stringify([{ product_id: product, quantity: '1.000', discount_fils: 0 }]);
const payments = JSON.stringify([{ method: 'cash', amount_fils: 1000, reference: null }]);
const deviceCheckout = (uid, secret, mutationId) => `SELECT public.checkout_sale_v2_device('${tenant}','${branch}','${items}','${payments}',0,NULL,NULL,'pos',0,NULL,'${mutationId}','${session}','${uid}','${secret}')`;
const successfulMutation = `${original}:successful-checkout`;

mark('credential-checkout');
const saleId = authAs(actor, deviceCheckout(original, credential, successfulMutation), 'credential checkout');
assert.match(saleId, /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i);
mark('credential-checkout-replay');
assert.equal(
  authAs(actor, deviceCheckout(original, credential, successfulMutation), 'credential checkout replay'),
  saleId,
  'A committed device checkout must return the same sale on response-loss replay',
);

const committed = {
  sales: Number(sql(`SELECT count(*) FROM public.sales WHERE tenant_id='${tenant}'`, 'committed sales check')),
  payments: Number(sql(`SELECT count(*) FROM public.payments WHERE tenant_id='${tenant}' AND sale_id='${saleId}'`, 'committed payments check')),
  movements: Number(sql(`SELECT count(*) FROM public.inventory_movements WHERE tenant_id='${tenant}' AND reference_id='${saleId}'`, 'committed movements check')),
  checkout_audits: Number(sql(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${tenant}' AND action='sale.checkout_committed' AND entity_id='${saleId}'`, 'committed audit check')),
  cash_fils: sql(`SELECT total_cash_fils FROM public.cash_sessions WHERE id='${session}'`, 'committed cash check'),
  stock: sql(`SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${center}' AND product_id='${product}'`, 'committed stock check'),
};
assert.deepEqual(committed, { sales: 1, payments: 1, movements: 1, checkout_audits: 1, cash_fils: '1000', stock: '1.000' });

mark('revocation');
assert.throws(
  () => authAs(actor, `SELECT public.revoke_device_enrollment('${tenant}','${device}','security incident')`, 'cashier device revocation'),
  /authoriz|permission|forbidden/i,
  'A cashier must not revoke an enrolled terminal',
);
assert.equal(
  authAs(manager, `SELECT public.revoke_device_enrollment('${tenant}','${device}','security incident')`, 'manager device revocation'),
  't',
  'An authorized manager must revoke an active terminal',
);
assert.equal(
  authAs(manager, `SELECT public.revoke_device_enrollment('${tenant}','${device}','security incident')`, 'manager device revocation replay'),
  'f',
  'Revocation replay must be a no-op',
);
assert.equal(
  sql(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${tenant}' AND action='device.enrollment_revoked' AND entity_id='${device}'`, 'revocation audit check'),
  '1',
  'Revocation and its replay must produce one immutable audit event',
);
mark('revoked-heartbeat-rejection');
assert.throws(() => authAs(actor, heartbeat(original, credential), 'revoked credential heartbeat'), /device credential rejected|revok|inactive/i,
  'A revoked credential must not refresh device authority');
mark('copied-credential-rejection');
assert.throws(() => authAs(actor, heartbeat(replacement, credential), 'copied credential heartbeat'), /device credential rejected|enroll|device|authoriz|forbidden|permission/i,
  'A copied credential on a replacement UID must not establish trusted enrollment');

mark('checkout-replay-after-revocation');
assert.throws(
  () => authAs(actor, deviceCheckout(original, credential, successfulMutation), 'checkout replay after revocation'),
  /device credential rejected|device|revok|authoriz|permission/i,
  'Revocation must be checked before an idempotent completed operation is returned',
);
mark('checkout-after-revocation');
assert.throws(
  () => authAs(actor, deviceCheckout(original, credential, `${original}:checkout-after-revocation`), 'checkout after revocation'),
  /device credential rejected|device|revok|authoriz|permission/i,
  'A revoked terminal must not submit checkout through the credential-bound RPC',
);
mark('copied-uid-checkout-rejection');
assert.throws(
  () => authAs(actor, deviceCheckout(replacement, credential, `${replacement}:copied-uid-checkout`), 'copied UID checkout'),
  /device credential rejected|device|enroll|authoriz|permission/i,
  'A copied UID must not submit checkout with another device credential',
);
mark('legacy-checkout-rejection');
assert.throws(
  () => authAs(actor, `SELECT public.checkout_sale_v2('${tenant}','${branch}','${items}','${payments}',0,NULL,NULL,'pos',0,NULL,'${original}:legacy-checkout','${session}')`, 'legacy checkout'),
  /permission denied|not authorized|forbidden/i,
  'Authenticated callers must not retain the credential-less checkout bypass',
);

mark('persistence-verification');
const persisted = {
  sales: Number(sql(`SELECT count(*) FROM public.sales WHERE tenant_id='${tenant}'`, 'sales persistence check')),
  payments: Number(sql(`SELECT count(*) FROM public.payments WHERE tenant_id='${tenant}' AND sale_id='${saleId}'`, 'payments persistence check')),
  movements: Number(sql(`SELECT count(*) FROM public.inventory_movements WHERE tenant_id='${tenant}' AND reference_id='${saleId}'`, 'movements persistence check')),
  checkout_audits: Number(sql(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${tenant}' AND action='sale.checkout_committed' AND entity_id='${saleId}'`, 'audit persistence check')),
  cash_fils: sql(`SELECT total_cash_fils FROM public.cash_sessions WHERE id='${session}'`, 'cash persistence check'),
  stock: sql(`SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${center}' AND product_id='${product}'`, 'stock persistence check'),
  revoked: sql(`SELECT revoked_at IS NOT NULL FROM public.devices WHERE id='${device}'`, 'revocation persistence check'),
};
assert.deepEqual(persisted, { ...committed, revoked: 't' }, 'Rejected post-revocation calls must add no financial, stock, or audit-authoritative effects');
assert.equal(persisted.revoked, 't');
console.log('SEC004_ENFORCEMENT ' + JSON.stringify({ credentialHeartbeatAccepted: true, crossBranchHeartbeatRejected: true, deviceCheckoutCommitted: true, checkoutReplayExactlyOnce: true, revokedHeartbeatRejected: true, copiedUidRejected: true, revokedCheckoutRejected: true, postRevocationEffectsUnchanged: true, legacyCheckoutRejected: true, persisted }));
console.log('PASS: credential lifecycle commits exactly once and rejects copied/revoked authority and legacy checkout bypass without additional effects.');
