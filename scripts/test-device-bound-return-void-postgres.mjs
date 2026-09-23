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
const mark = stage => console.log(`SEC004_RETURN_VOID_STAGE ${stage}`);

const tenant = 'aa000000-0000-0000-0000-000000000701';
const branch = 'bb000000-0000-0000-0000-000000000701';
const otherBranch = 'bb000000-0000-0000-0000-000000000702';
const manager = 'cc000000-0000-0000-0000-000000000701';
const session = 'dd000000-0000-0000-0000-000000000701';
const center = 'ee000000-0000-0000-0000-000000000701';
const product = 'ff000000-0000-0000-0000-000000000701';
const deviceUid = 'SEC004-return-void-terminal';
const copiedUid = 'SEC004-copied-return-void-terminal';

mark('fixture');
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${manager}','sec004-return-void@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock) VALUES('${tenant}','Return Void Device','return-void-device-contract','BHD',10,false,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES
  ('${branch}','${tenant}','Return Void Device','active'),
  ('${otherBranch}','${tenant}','Other Return Void Device','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
  ('${manager}','${tenant}','${branch}','manager'),
  ('${manager}','${tenant}','${otherBranch}','manager');
INSERT INTO public.cash_sessions(id,tenant_id,branch_id,user_id,status) VALUES('${session}','${tenant}','${branch}','${manager}','open');
INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES('${center}','${tenant}','${branch}','Return Void POS','point_of_sale','active');
INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status) VALUES('${product}','${tenant}','Return Void Product','simple',1.000,0.500,0,'active');
INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES('${tenant}','${branch}','${center}','${product}',10.000);`, 'fixture');

const authAs = (statement, stage) => sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${manager}'; ${statement}; COMMIT;`, stage);
const approval = authAs(`SELECT public.approve_device_enrollment('${tenant}','${branch}','${deviceUid}')`, 'manager approval');
const activated = sql(`SET ROLE service_role; SELECT device_id::text || '|' || device_uid || '|' || credential FROM public.activate_device_enrollment('${approval}','1.0.0','windows'); RESET ROLE;`, 'credential activation');
const [device, activatedUid, credential] = activated.split('|');
assert.equal(activatedUid, deviceUid);
assert.match(credential, /^[a-f\d]{64}$/i);

const items = JSON.stringify([{ product_id: product, quantity: '1.000', discount_fils: 0 }]);
const payments = JSON.stringify([{ method: 'cash', amount_fils: 1000, reference: null }]);
const checkout = mutation => authAs(
  `SELECT public.checkout_sale_v2_device('${tenant}','${branch}','${items}','${payments}',0,NULL,NULL,'pos',0,NULL,'${mutation}','${session}','${deviceUid}','${credential}')`,
  `checkout ${mutation}`,
);
const returnSale = checkout('SEC004-return-sale');
const voidSale = checkout('SEC004-void-sale');
const returnItem = sql(`SELECT id FROM public.sale_items WHERE sale_id='${returnSale}'`, 'return item lookup');
const returnItems = JSON.stringify([{ sale_item_id: returnItem, quantity: 1 }]);

const deviceReturn = (uid, secret, mutation, branchId = branch) =>
  `SELECT public.process_sale_return_v3_device('${tenant}','${branchId}','${returnSale}','${returnItems}'::jsonb,'customer_request','${mutation}','${session}','Verified return',NULL,'${uid}','${secret}')`;
const deviceVoid = (uid, secret, mutation, branchId = branch) =>
  `SELECT public.process_sale_void_v3_device('${tenant}','${branchId}','${voidSale}','${mutation}','${session}','Verified void','${uid}','${secret}')`;
const snapshot = stage => sql(
  `SELECT (SELECT count(*) FROM public.sale_returns WHERE tenant_id='${tenant}')::text
    || '|' || (SELECT count(*) FROM public.sale_voids WHERE tenant_id='${tenant}')::text
    || '|' || (SELECT count(*) FROM public.payment_refunds WHERE tenant_id='${tenant}')::text
    || '|' || (SELECT count(*) FROM public.payment_voids WHERE tenant_id='${tenant}')::text
    || '|' || (SELECT count(*) FROM public.audit_logs WHERE tenant_id='${tenant}' AND action IN ('sale.returned_v2','sale.voided_v2'))::text
    || '|' || (SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${center}' AND product_id='${product}')
    || '|' || (SELECT total_cash_fils::text FROM public.cash_sessions WHERE id='${session}')`,
  stage,
);

const beforeDenied = snapshot('denial baseline');
assert.equal(beforeDenied, '0|0|0|0|0|8.000|2000');
mark('legacy-return-rejection');
assert.throws(
  () => authAs(`SELECT public.process_sale_return_v2('${returnSale}','${returnItems}'::jsonb,'customer_request','legacy-return','${session}','Legacy',NULL)`, 'legacy return'),
  /permission denied|not authorized|forbidden/i,
);
mark('legacy-void-rejection');
assert.throws(
  () => authAs(`SELECT public.process_sale_void_v2('${voidSale}','legacy-void','${session}','Legacy')`, 'legacy void'),
  /permission denied|not authorized|forbidden/i,
);
for (const [name, statement] of [
  ['missing return credential', deviceReturn(deviceUid, '', 'missing-return')],
  ['copied return credential', deviceReturn(copiedUid, credential, 'copied-return')],
  ['wrong-branch return credential', deviceReturn(deviceUid, credential, 'branch-return', otherBranch)],
  ['missing void credential', deviceVoid(deviceUid, '', 'missing-void')],
  ['copied void credential', deviceVoid(copiedUid, credential, 'copied-void')],
  ['wrong-branch void credential', deviceVoid(deviceUid, credential, 'branch-void', otherBranch)],
]) {
  mark(name.replaceAll(' ', '-'));
  assert.throws(() => authAs(statement, name), /device credential|required|scope|authoriz|permission/i, name);
}
assert.equal(snapshot('denied zero-effect check'), beforeDenied, 'Denied return/void calls must have zero financial, stock, audit, or operation effects');

mark('credential-return');
const returnId = authAs(deviceReturn(deviceUid, credential, 'device-return-001'), 'credential return');
assert.match(returnId, /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i);
assert.equal(authAs(deviceReturn(deviceUid, credential, 'device-return-001'), 'credential return replay'), returnId);
mark('credential-void');
const voidId = authAs(deviceVoid(deviceUid, credential, 'device-void-001'), 'credential void');
assert.match(voidId, /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i);
assert.equal(authAs(deviceVoid(deviceUid, credential, 'device-void-001'), 'credential void replay'), voidId);
assert.equal(snapshot('committed exactly-once check'), '1|1|1|1|2|10.000|0');

mark('revocation');
assert.equal(authAs(`SELECT public.revoke_device_enrollment('${tenant}','${device}','security incident')`, 'device revocation'), 't');
const revokedBaseline = snapshot('revoked baseline');
for (const [name, statement] of [
  ['return replay after revocation', deviceReturn(deviceUid, credential, 'device-return-001')],
  ['new return after revocation', deviceReturn(deviceUid, credential, 'device-return-after-revoke')],
  ['void replay after revocation', deviceVoid(deviceUid, credential, 'device-void-001')],
  ['new void after revocation', deviceVoid(deviceUid, credential, 'device-void-after-revoke')],
]) {
  mark(name.replaceAll(' ', '-'));
  assert.throws(() => authAs(statement, name), /device credential|revok|authoriz|permission/i, name);
}
assert.equal(snapshot('revoked zero-effect check'), revokedBaseline, 'Revoked return/void requests and replays must have zero effects');

console.log('SEC004_RETURN_VOID ' + JSON.stringify({ legacyBypassRejected: true, missingCredentialRejected: true, copiedCredentialRejected: true, wrongBranchRejected: true, returnExactlyOnce: true, voidExactlyOnce: true, revokedReplayRejected: true, zeroRejectedEffects: true }));
console.log('PASS: returns and voids require native device authority before replay or financial effect.');
