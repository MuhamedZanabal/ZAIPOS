import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connection, literal, query } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable contract database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = statement => query(conn, statement);
const userSql = (user, statement) => `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub=${literal(user)}; ${statement}; COMMIT;`;
const asUser = (user, statement) => sql(userSql(user, statement));
// postgres-recovery deliberately redacts database diagnostics. The contract still
// proves fail-closed behavior by requiring psql failure and comparing full state.
const reject = (user, statement) => assert.throws(() => asUser(user, statement));
const exec = promisify(execFile);

const I = {
  tenant: 'a1000000-0000-0000-0000-000000000088', branch: 'b1000000-0000-0000-0000-000000000088',
  inactive: 'b2000000-0000-0000-0000-000000000088', manager: 'c1000000-0000-0000-0000-000000000088',
  cashier: 'c2000000-0000-0000-0000-000000000088', centerA: 'd1000000-0000-0000-0000-000000000088',
  centerB: 'd2000000-0000-0000-0000-000000000088', inactiveCenter: 'd3000000-0000-0000-0000-000000000088',
  product: 'e1000000-0000-0000-0000-000000000088', output: 'e2000000-0000-0000-0000-000000000088',
  ingredient: 'e3000000-0000-0000-0000-000000000088', purchase: 'f1000000-0000-0000-0000-000000000088',
  production: 'f2000000-0000-0000-0000-000000000088', supplier: 'f3000000-0000-0000-0000-000000000088',
};
const uid = 'SEC088-inventory-terminal';
const copiedUid = 'SEC088-inventory-copied';
const inactiveUid = 'SEC088-inventory-inactive';
const secret = '8'.repeat(64);
const otherSecret = '9'.repeat(64);
const inactiveSecret = 'a'.repeat(64);

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.manager}','sec088-inventory-manager@zaipos.test','{}'),
    ('${I.cashier}','sec088-inventory-cashier@zaipos.test','{}');
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock)
    VALUES('${I.tenant}','Inventory Device Contract','inventory-device-contract','BHD',10,false,false);
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branch}','${I.tenant}','Active Inventory','active'),
    ('${I.inactive}','${I.tenant}','Inactive Inventory','inactive');
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.manager}','${I.tenant}','${I.branch}','manager'),
    ('${I.manager}','${I.tenant}','${I.inactive}','manager'),
    ('${I.cashier}','${I.tenant}','${I.branch}','cashier');
  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES
    ('${I.centerA}','${I.tenant}','${I.branch}','Primary','warehouse','active'),
    ('${I.centerB}','${I.tenant}','${I.branch}','Secondary','warehouse','active'),
    ('${I.inactiveCenter}','${I.tenant}','${I.inactive}','Inactive','warehouse','active');
  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status) VALUES
    ('${I.product}','${I.tenant}','Stock Item','simple',1.000,0.500,10,'active'),
    ('${I.output}','${I.tenant}','Produced Item','production',2.000,1.000,10,'active'),
    ('${I.ingredient}','${I.tenant}','Ingredient','ingredient',0.500,0.250,10,'active');
  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES
    ('${I.tenant}','${I.branch}','${I.centerA}','${I.product}',20.000),
    ('${I.tenant}','${I.branch}','${I.centerA}','${I.output}',0.000),
    ('${I.tenant}','${I.branch}','${I.centerA}','${I.ingredient}',20.000),
    ('${I.tenant}','${I.branch}','${I.centerB}','${I.product}',0.000);
  INSERT INTO public.product_components(tenant_id,parent_product_id,component_product_id,quantity,waste_pct)
    VALUES('${I.tenant}','${I.output}','${I.ingredient}',2.000,0);
  INSERT INTO public.suppliers(id,tenant_id,name,status)
    VALUES('${I.supplier}','${I.tenant}','Inventory Device Supplier','active');
  INSERT INTO public.purchase_orders(id,tenant_id,branch_id,supplier_id,status,total)
    VALUES('${I.purchase}','${I.tenant}','${I.branch}','${I.supplier}','draft',1.000);
  INSERT INTO public.purchase_order_items(order_id,tenant_id,product_id,product_name,quantity,cost_price,line_total)
    VALUES('${I.purchase}','${I.tenant}','${I.product}','Stock Item',2.000,0.500,1.000);
  INSERT INTO public.production_orders(id,tenant_id,branch_id,product_id,planned_quantity)
    VALUES('${I.production}','${I.tenant}','${I.branch}','${I.output}',3.000);
  INSERT INTO public.devices(tenant_id,branch_id,device_uid,app_version,os,credential_hash,credential_issued_at) VALUES
    ('${I.tenant}','${I.branch}','${uid}','1.0.0','windows',extensions.digest(convert_to('${secret}','UTF8'),'sha256'),now()),
    ('${I.tenant}','${I.branch}','${copiedUid}','1.0.0','windows',extensions.digest(convert_to('${otherSecret}','UTF8'),'sha256'),now()),
    ('${I.tenant}','${I.inactive}','${inactiveUid}','1.0.0','windows',extensions.digest(convert_to('${inactiveSecret}','UTF8'),'sha256'),now());
`);

const batch = (op='sec088-batch', credential=secret, device=uid, branch=I.branch, center=I.centerA, quantity='1.250') =>
  `SELECT public.record_inventory_batch_v3_device('${I.tenant}','${branch}','${center}',` +
  `'[{"product_id":"${I.product}","movement_type":"purchase","quantity":"${quantity}","effect_key":"line-a"}]'::jsonb,` +
  `${literal(op)},'Device contract',${literal(device)},${literal(credential)})::text`;
const reconcile = (op='sec088-reconcile', credential=secret, device=uid, branch=I.branch, center=I.centerA, quantity='25.500') =>
  `SELECT public.reconcile_inventory_levels_v3_device('${I.tenant}','${branch}','${center}',` +
  `'[{"product_id":"${I.product}","target_quantity":"${quantity}","effect_key":"count-a"}]'::jsonb,` +
  `${literal(op)},'Device count',${literal(device)},${literal(credential)})::text`;
const transfer = (op='sec088-transfer', credential=secret, device=uid, branch=I.branch, from=I.centerA, quantity='2.000') =>
  `SELECT public.transfer_inventory_v3_device('${I.tenant}','${branch}','${I.product}','${from}','${I.centerB}',${quantity},` +
  `'Device transfer',${literal(op)},${literal(device)},${literal(credential)})::text`;
const receive = (op='sec088-receive', credential=secret, device=uid, branch=I.branch, order=I.purchase, center=I.centerA) =>
  `SELECT public.receive_purchase_order_v3_device('${I.tenant}','${branch}','${order}','${center}',${literal(op)},${literal(device)},${literal(credential)})::text`;
const production = (op='sec088-production', credential=secret, device=uid, branch=I.branch, order=I.production, produced='3.000') =>
  `SELECT public.complete_production_order_v3_device('${I.tenant}','${branch}','${order}',${produced},0,${literal(op)},${literal(device)},${literal(credential)})::text`;
const calls = [batch, reconcile, transfer, receive, production];

for (const signature of [
  'record_inventory_batch_v2(uuid,uuid,uuid,jsonb,text,text)',
  'reconcile_inventory_levels_v2(uuid,uuid,uuid,jsonb,text,text)',
  'transfer_inventory_v2(uuid,uuid,uuid,uuid,uuid,numeric,text,text)',
  'receive_purchase_order_v2(uuid,uuid,text)',
  'complete_production_order_v2(uuid,numeric,numeric,text)',
]) assert.equal(sql(`SELECT has_function_privilege('authenticated', 'public.${signature}', 'EXECUTE')`), 'f', `${signature} remains executable`);

const snapshot = () => sql(`SELECT
  (SELECT count(*) FROM public.inventory_operations WHERE tenant_id='${I.tenant}') || '|' ||
  (SELECT count(*) FROM public.inventory_movements WHERE tenant_id='${I.tenant}') || '|' ||
  (SELECT coalesce(sum(quantity),0) FROM public.inventory_stocks WHERE tenant_id='${I.tenant}') || '|' ||
  (SELECT status FROM public.purchase_orders WHERE id='${I.purchase}') || '|' ||
  (SELECT status FROM public.production_orders WHERE id='${I.production}')`);
const baseline = snapshot();
for (const call of calls) {
  reject(I.manager, call(undefined, '', uid));
  reject(I.manager, call(undefined, secret, copiedUid));
  reject(I.manager, call(undefined, otherSecret, uid));
  reject(I.cashier, call());
  reject(I.manager, call(undefined, inactiveSecret, inactiveUid, I.inactive, I.inactiveCenter));
  assert.equal(snapshot(), baseline, 'Rejected inventory authority request changed financial state');
}

const concurrent = async statement => {
  const replies = await Promise.all(Array.from({length:4}, () => exec('psql', ['-X','-Atq','-v','ON_ERROR_STOP=1','-c',userSql(I.manager, statement)], {env:conn.env, encoding:'utf8'})));
  const ids = replies.map(reply => reply.stdout.trim());
  assert.equal(new Set(ids).size, 1, 'Concurrent identical requests did not converge');
  assert.match(ids[0], /^[0-9a-f-]{36}$/i);
  return ids[0];
};
for (const call of calls) {
  const id = await concurrent(call());
  assert.equal(asUser(I.manager, call()), id, 'Lost-response replay did not return original operation');
}
reject(I.manager, batch('sec088-batch', secret, uid, I.branch, I.centerA, '9.000'));
reject(I.manager, reconcile('sec088-reconcile', secret, uid, I.branch, I.centerA, '29.000'));
reject(I.manager, transfer('sec088-transfer', secret, uid, I.branch, I.centerA, '3.000'));
reject(I.manager, receive('sec088-receive', secret, uid, I.branch, I.purchase, I.centerB));
reject(I.manager, production('sec088-production', secret, uid, I.branch, I.production, '2.000'));

sql(`UPDATE public.devices SET revoked_at=now() WHERE tenant_id='${I.tenant}' AND branch_id='${I.branch}' AND device_uid='${uid}'`);
const committed = snapshot();
for (const call of calls) reject(I.manager, call());
assert.equal(snapshot(), committed, 'Revoked-device replay changed financial state');

console.log('PASS: all five inventory financial commands deny legacy, missing, copied, mismatched, inactive, wrong-role, and revoked authority with zero rejected effects; exact concurrent requests converge, replay returns the receipt, and payload substitution fails.');
