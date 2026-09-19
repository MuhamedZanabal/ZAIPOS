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
const actor = 'cc000000-0000-0000-0000-000000000601';
const manager = 'cc000000-0000-0000-0000-000000000602';
const session = 'dd000000-0000-0000-0000-000000000601';
const center = 'ee000000-0000-0000-0000-000000000601';
const product = 'ff000000-0000-0000-0000-000000000601';
const original = 'SEC004-original-terminal';
const replacement = 'SEC004-copied-renderer-new-uid';

mark('fixture');
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
  ('${actor}','device-boundary@zaipos.test','{}'),
  ('${manager}','device-manager@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock) VALUES('${tenant}','Device Boundary','device-boundary-contract','BHD',10,false,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${branch}','${tenant}','Device Boundary','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
  ('${actor}','${tenant}','${branch}','cashier'),
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

mark('revocation');
sql(`UPDATE public.devices SET revoked_at=now(), is_active=false WHERE id='${device}'`, 'device revocation');
mark('revoked-heartbeat-rejection');
assert.throws(() => authAs(actor, heartbeat(original, credential), 'revoked credential heartbeat'), /device credential rejected|revok|inactive/i,
  'A revoked credential must not refresh device authority');
mark('copied-credential-rejection');
assert.throws(() => authAs(actor, heartbeat(replacement, credential), 'copied credential heartbeat'), /device credential rejected|enroll|device|authoriz|forbidden|permission/i,
  'A copied credential on a replacement UID must not establish trusted enrollment');

const items = JSON.stringify([{ product_id: product, quantity: '1.000', discount_fils: 0 }]);
const payments = JSON.stringify([{ method: 'cash', amount_fils: 1000, reference: null }]);
let checkoutAccepted = false;
mark('checkout-after-revocation');
try {
  authAs(actor, `SELECT public.checkout_sale_v2('${tenant}','${branch}','${items}','${payments}',0,NULL,NULL,'pos',0,NULL,'${original}:checkout-after-revocation','${session}')`, 'checkout after revocation');
  checkoutAccepted = true;
} catch (error) {
  if (!/device|enroll|revok|authoriz|permission/i.test(error.message)) throw error;
}

mark('persistence-verification');
const persisted = {
  sales: Number(sql(`SELECT count(*) FROM public.sales WHERE tenant_id='${tenant}'`, 'sales persistence check')),
  cash_fils: sql(`SELECT total_cash_fils FROM public.cash_sessions WHERE id='${session}'`, 'cash persistence check'),
  stock: sql(`SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${center}' AND product_id='${product}'`, 'stock persistence check'),
  revoked: sql(`SELECT revoked_at IS NOT NULL FROM public.devices WHERE id='${device}'`, 'revocation persistence check'),
};
if (checkoutAccepted) {
  assert.equal(persisted.sales, 1);
  assert.equal(persisted.cash_fils, '1000');
  assert.equal(persisted.stock, '1.000');
} else {
  assert.equal(persisted.sales, 0);
  assert.equal(persisted.cash_fils, '0');
  assert.equal(persisted.stock, '2.000');
}
assert.equal(persisted.revoked, 't');
console.log('SEC004_REPRODUCTION ' + JSON.stringify({ credentialHeartbeatAccepted: true, revokedHeartbeatRejected: true, replacementAccepted: false, checkoutAccepted, persisted }));
assert.equal(checkoutAccepted, false, 'A revoked terminal must not submit a new checkout without valid device authority');
console.log('PASS: credential lifecycle rejects copied/revoked heartbeat and revoked-terminal checkout.');