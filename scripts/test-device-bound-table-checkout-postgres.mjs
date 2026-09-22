import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable contract database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = (statement, stage = 'table checkout fixture') => {
  try { return execFileSync('psql', ['-X','-Atq','-v','ON_ERROR_STOP=1','-c',statement], { env: conn.env, encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim(); }
  catch (error) { throw new Error(`${stage}: ${String(error.stderr ?? error.message).trim()}`); }
};
const authAs = (user, statement, stage) => sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${user}'; ${statement}; COMMIT;`, stage);

const I = {
  tenant:'ae000000-0000-0000-0000-000000000101', branch:'be000000-0000-0000-0000-000000000101', otherBranch:'be000000-0000-0000-0000-000000000102',
  manager:'ce000000-0000-0000-0000-000000000101', waiter:'ce000000-0000-0000-0000-000000000102', outsider:'ce000000-0000-0000-0000-000000000103',
  center:'de000000-0000-0000-0000-000000000101', product:'ee000000-0000-0000-0000-000000000101', table:'fa000000-0000-0000-0000-000000000101',
  order:'fa000000-0000-0000-0000-000000000102', item:'fa000000-0000-0000-0000-000000000103', session:'fa000000-0000-0000-0000-000000000104',
};
const deviceUid='table-checkout-terminal';
const copiedUid='copied-table-terminal';

sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 ('${I.manager}','table-manager@zaipos.test','{}'),('${I.waiter}','table-waiter@zaipos.test','{}'),('${I.outsider}','table-outsider@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock) VALUES('${I.tenant}','Table Device','table-device-contract','BHD',10,false,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${I.branch}','${I.tenant}','Table Branch','active'),('${I.otherBranch}','${I.tenant}','Other Table Branch','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
 ('${I.manager}','${I.tenant}','${I.branch}','manager'),('${I.waiter}','${I.tenant}','${I.branch}','waiter'),('${I.outsider}','${I.tenant}','${I.otherBranch}','cashier');
INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES('${I.center}','${I.tenant}','${I.branch}','Table POS','point_of_sale','active');
INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status) VALUES('${I.product}','${I.tenant}','Table Item','simple',1.000,0.500,0,'active');
INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES('${I.tenant}','${I.branch}','${I.center}','${I.product}',3.000);
INSERT INTO public.tables(id,tenant_id,branch_id,name,status) VALUES('${I.table}','${I.tenant}','${I.branch}','T1','occupied');
INSERT INTO public.table_orders(id,tenant_id,branch_id,table_id,waiter_id,status) VALUES('${I.order}','${I.tenant}','${I.branch}','${I.table}','${I.waiter}','sent_to_cashier');
INSERT INTO public.table_order_items(id,tenant_id,order_id,product_id,product_name,product_type,quantity,unit_price,tax_rate,discount,line_total,status)
 VALUES('${I.item}','${I.tenant}','${I.order}','${I.product}','Table Item','simple',1.000,1.000,0,0,1.000,'dispatched');
INSERT INTO public.cash_sessions(id,tenant_id,branch_id,user_id) VALUES('${I.session}','${I.tenant}','${I.branch}','${I.waiter}');`);

const approval=authAs(I.manager,`SELECT public.approve_device_enrollment('${I.tenant}','${I.branch}','${deviceUid}')`,'device approval');
const [deviceId,credential]=sql(`SET ROLE service_role; SELECT device_id::text||'|'||credential FROM public.activate_device_enrollment('${approval}','1.0.0','windows'); RESET ROLE;`,'device activation').split('|');
assert.match(credential,/^[a-f\d]{64}$/i);

const operation='table-checkout:fa000000-0000-0000-0000-000000000102';
const call=({branch=I.branch,uid=deviceUid,secret=credential,payments=`[{"method":"cash","amount":"1.000","reference":null}]`,op=operation}={}) =>
 `SELECT public.checkout_table_order_v2_device('${I.tenant}','${branch}','${I.order}','${payments}'::jsonb,0.000,0.000,NULL,'${op}','${uid}','${secret}')::text`;
const snapshot=()=>sql(`SELECT (SELECT count(*) FROM public.sales WHERE tenant_id='${I.tenant}')||'|'||(SELECT count(*) FROM public.payments p JOIN public.sales s ON s.id=p.sale_id WHERE s.tenant_id='${I.tenant}')||'|'||(SELECT total_cash_fils FROM public.cash_sessions WHERE id='${I.session}')||'|'||(SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.product}')`);
const deniedBaseline=snapshot();
assert.equal(sql(`SELECT has_function_privilege('authenticated','public.checkout_table_order(uuid,jsonb,numeric,numeric,text,text)','EXECUTE')`),'f');
assert.equal(sql(`SELECT has_function_privilege('authenticated','public.require_table_checkout_device_v1(uuid,uuid,text,text)','EXECUTE')`),'f');
assert.throws(()=>authAs(I.waiter,`SELECT public.checkout_table_order('${I.order}','[]'::jsonb,0,0,NULL,'legacy-table-checkout')`,'legacy bypass'),/permission denied/i);
for (const [name,statement] of [
 ['missing credential',call({secret:''})],['copied credential',call({uid:copiedUid})],['wrong branch',call({branch:I.otherBranch})],
]) assert.throws(()=>authAs(I.waiter,statement,name),/device credential|scope|authoriz|permission/i,name);
assert.equal(snapshot(),deniedBaseline,'denied table checkouts must have zero financial effect');

const sale=authAs(I.waiter,call(),'valid checkout');
assert.match(sale,/^[a-f\d-]{36}$/i);
assert.equal(authAs(I.waiter,call(),'lost-response replay'),sale);
assert.equal(snapshot(),'1|1|1000|2.000');
assert.equal(sql(`SELECT status::text||'|'||sale_id::text FROM public.table_orders WHERE id='${I.order}'`),`closed|${sale}`);
assert.throws(()=>authAs(I.waiter,call({payments:`[{"method":"card","amount":"1.000","reference":null}]` }),'payload substitution'),/different checkout request|mutation ID/i);
assert.equal(snapshot(),'1|1|1000|2.000');

assert.equal(authAs(I.manager,`SELECT public.revoke_device_enrollment('${I.tenant}','${deviceId}','table checkout regression')`,'device revocation'),'t');
assert.throws(()=>authAs(I.waiter,call(),'revoked replay'),/device credential|revok|authoriz/i);
assert.equal(snapshot(),'1|1|1000|2.000');

console.log('PASS: table checkout requires native device authority, converges after lost responses, and rejects credential or payload substitution with zero extra effects.');
