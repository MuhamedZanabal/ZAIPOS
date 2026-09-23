import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable contract database required');
const conn=connection(process.env.POSTGRES_ADMIN_URL);
const sql=(statement,stage='table-item authority')=>{try{return execFileSync('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',statement],{env:conn.env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}catch(error){throw new Error(`${stage}: ${String(error.stderr??error.message).trim()}`);}};
const authAs=(user,statement,stage)=>sql(`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${user}';${statement};COMMIT;`,stage);
const execAsync=promisify(execFile);
const I={
 tenant:'a9100000-0000-0000-0000-000000000001',branch:'b9100000-0000-0000-0000-000000000001',otherBranch:'b9100000-0000-0000-0000-000000000002',
 manager:'c9100000-0000-0000-0000-000000000001',waiter:'c9100000-0000-0000-0000-000000000002',otherWaiter:'c9100000-0000-0000-0000-000000000003',outsider:'c9100000-0000-0000-0000-000000000004',kitchen:'c9100000-0000-0000-0000-000000000005',
 product:'d9100000-0000-0000-0000-000000000001',detail:'d9100000-0000-0000-0000-000000000002',table:'e9100000-0000-0000-0000-000000000001',order:'f9100000-0000-0000-0000-000000000001',center:'a9100000-0000-0000-0000-000000000099'
};
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
('${I.manager}','table-item-manager@zaipos.test','{}'),('${I.waiter}','table-item-waiter@zaipos.test','{}'),
('${I.otherWaiter}','table-item-other-waiter@zaipos.test','{}'),('${I.outsider}','table-item-outsider@zaipos.test','{}'),
('${I.kitchen}','table-item-kitchen@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES('${I.tenant}','Table Item Authority','table-item-authority','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${I.branch}','${I.tenant}','Restaurant','active'),('${I.otherBranch}','${I.tenant}','Other','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
('${I.manager}','${I.tenant}','${I.branch}','manager'),('${I.waiter}','${I.tenant}','${I.branch}','waiter'),
('${I.otherWaiter}','${I.tenant}','${I.branch}','waiter'),('${I.outsider}','${I.tenant}','${I.otherBranch}','cashier'),
('${I.kitchen}','${I.tenant}','${I.branch}','kitchen');
INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status,requires_detail) VALUES
('${I.product}','${I.tenant}','Authoritative Meal','simple',1.000,0.500,10,'active',false),
('${I.detail}','${I.tenant}','Prepared Steak','simple',2.000,0.800,10,'active',true);
INSERT INTO public.branch_products(tenant_id,branch_id,product_id,is_available,local_price) VALUES('${I.tenant}','${I.branch}','${I.product}',true,1.250);
INSERT INTO public.product_channel_prices(tenant_id,product_id,branch_id,channel,price) VALUES('${I.tenant}','${I.product}','${I.branch}','tables',1.500);
INSERT INTO public.tables(id,tenant_id,branch_id,name,status,assigned_waiter_id) VALUES('${I.table}','${I.tenant}','${I.branch}','Authority Table','occupied','${I.waiter}');
INSERT INTO public.table_orders(id,tenant_id,branch_id,table_id,waiter_id,status) VALUES('${I.order}','${I.tenant}','${I.branch}','${I.table}','${I.waiter}','open');
INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES('${I.center}','${I.tenant}','${I.branch}','Bodega Principal','warehouse','active');
INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity)
VALUES('${I.tenant}','${I.branch}','${I.center}','${I.product}',10.000);`);

const call=({actor=I.waiter,branch=I.branch,op='table-item-add-001',action='add',item=null,product=I.product,quantity='1.000',notes=null}={})=>authAs(actor,
`SELECT public.mutate_table_order_item_v2('${I.tenant}','${branch}','${I.order}','${op}','${action}',${item?`'${item}'`:'NULL'},${product?`'${product}'`:'NULL'},${quantity??'NULL'},${notes===null?'NULL':`'${String(notes).replaceAll("'","''")}'`})::text`,op);
const snapshot=()=>sql(`SELECT
(SELECT count(*) FROM public.table_order_items WHERE order_id='${I.order}')||'|'||
(SELECT COALESCE(sum(quantity),0) FROM public.table_order_items WHERE order_id='${I.order}')||'|'||
(SELECT subtotal::text||':'||tax_total::text||':'||total::text FROM public.table_orders WHERE id='${I.order}')||'|'||
(SELECT count(*) FROM public.operation_log WHERE tenant_id='${I.tenant}' AND operation_type='mutate_table_order_item_v2')`);

assert.equal(sql(`SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='table_order_items' AND policyname='toi_member_all'`),'0');
for(const privilege of ['INSERT','UPDATE','DELETE']) assert.equal(sql(`SELECT has_table_privilege('authenticated','public.table_order_items','${privilege}')`),'f');
assert.equal(sql(`SELECT has_function_privilege('authenticated','public.recalc_table_order(uuid)','EXECUTE')`),'f');
for(const [label,statement] of [
 ['direct insert',`INSERT INTO public.table_order_items(tenant_id,order_id,product_id,product_name,product_type) VALUES('${I.tenant}','${I.order}','${I.product}','Bypass','simple')`],
 ['direct update',`UPDATE public.table_order_items SET quantity=999 WHERE order_id='${I.order}'`],
 ['direct delete',`DELETE FROM public.table_order_items WHERE order_id='${I.order}'`],
]) assert.throws(()=>authAs(I.manager,statement,label),/permission denied/i,label);

const empty=snapshot();
assert.throws(()=>call({actor:I.otherWaiter,op:'table-item-unassigned'}),/not assigned|forbidden|permission/i);
assert.throws(()=>call({actor:I.outsider,branch:I.otherBranch,op:'table-item-wrong-branch'}),/scope|forbidden|permission/i);
assert.throws(()=>call({op:'table-item-fractional',quantity:'1.0001'}),/three decimal/i);
assert.throws(()=>call({op:'table-item-detail',product:I.detail}),/details are required/i);
assert.equal(snapshot(),empty,'denied requests must have zero item, total, or journal effect');

const item=call();assert.match(item,/^[a-f\d-]{36}$/i);
assert.equal(sql(`SELECT unit_price::text||'|'||line_total::text FROM public.table_order_items WHERE id='${item}'`),'1.500|1.650');
assert.equal(snapshot(),'1|1.000|1.500:0.150:1.650|1');
assert.equal(call(),item,'lost-response replay must return the original item');
assert.equal(snapshot(),'1|1.000|1.500:0.150:1.650|1');
assert.throws(()=>call({quantity:'2.000'}),/different request|operation ID/i);
assert.equal(snapshot(),'1|1.000|1.500:0.150:1.650|1');

assert.equal(call({actor:I.manager,op:'table-item-qty-001',action:'set_quantity',item,product:null,quantity:'2.000'}),item);
assert.equal(snapshot(),'1|2.000|3.000:0.300:3.300|2');
assert.equal(call({actor:I.manager,op:'table-item-delete-001',action:'delete',item,product:null,quantity:null}),item);
assert.equal(snapshot(),'0|0|0.000:0.000:0.000|3');

const fractional=call({op:'table-item-exact-fils-001',quantity:'0.001'});
assert.equal(snapshot(),'1|0.001|0.002:0.000:0.002|4','fractional quantities must round once into exact integer fils');
assert.equal(call({actor:I.manager,op:'table-item-exact-fils-delete',action:'delete',item:fractional,product:null,quantity:null}),fractional);
assert.equal(snapshot(),'0|0|0.000:0.000:0.000|5');
assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${I.tenant}' AND action LIKE 'table_order_item.%'`),'5');

const concurrentSql=`SELECT public.mutate_table_order_item_v2('${I.tenant}','${I.branch}','${I.order}','table-item-concurrent-001','add',NULL,'${I.product}',1.000,NULL)::text`;
const run=()=>execAsync('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${I.waiter}';${concurrentSql};COMMIT;`],{env:conn.env,encoding:'utf8'}).then(({stdout})=>stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
const concurrent=await Promise.all([run(),run()]);
assert.equal(concurrent[0],concurrent[1]);
assert.equal(snapshot(),'1|1.000|1.500:0.150:1.650|6');

for(const fn of ['start_preparing_table_item','mark_table_item_ready','dispatch_table_item','undispatch_table_item'])
  assert.equal(sql(`SELECT has_function_privilege('authenticated','public.${fn}(uuid)','EXECUTE')`),'f',`${fn} legacy execution must be revoked`);
for(const fn of ['send_table_order_to_kitchen','mark_table_order_ready'])
  assert.equal(sql(`SELECT has_function_privilege('authenticated','public.${fn}(uuid)','EXECUTE')`),'f',`${fn} legacy execution must be revoked`);
assert.equal(sql(`SELECT has_function_privilege('authenticated','public.apply_table_dispatch_inventory_effect_v2(uuid,uuid,uuid,public.movement_type,numeric,text,uuid,uuid)','EXECUTE')`),'f');

const transition=({actor=I.waiter,branch=I.branch,op,action,item=concurrent[0]}={})=>authAs(actor,
`SELECT (public.transition_table_item_v2('${I.tenant}','${branch}','${item}','${op}','${action}')).status::text`,op);
const effectSnapshot=()=>sql(`SELECT
(SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.product}')||'|'||
(SELECT count(*) FROM public.inventory_movements WHERE reference_id='${I.order}')||'|'||
(SELECT count(*) FROM public.operation_log WHERE tenant_id='${I.tenant}' AND operation_type='transition_table_item_v2')`);

const beforeEffects=effectSnapshot();
assert.throws(()=>transition({actor:I.otherWaiter,op:'transition-unassigned-001',action:'dispatch'}),/forbidden|permission/i);
assert.throws(()=>transition({actor:I.outsider,branch:I.otherBranch,op:'transition-wrong-branch-001',action:'dispatch'}),/scope|forbidden|permission/i);
assert.throws(()=>transition({actor:I.kitchen,op:'transition-kitchen-dispatch',action:'dispatch'}),/forbidden|permission/i);
assert.equal(effectSnapshot(),beforeEffects,'denied transition requests must have zero inventory or journal effect');

assert.equal(transition({actor:I.kitchen,op:'transition-kitchen-start',action:'start_preparing'}),'preparing');
assert.equal(transition({actor:I.kitchen,op:'transition-kitchen-ready',action:'mark_ready'}),'ready');
assert.equal(transition({op:'transition-dispatch-001',action:'dispatch'}),'dispatched');
assert.equal(effectSnapshot(),'9.000|1|3');
assert.equal(transition({op:'transition-dispatch-001',action:'dispatch'}),'dispatched','lost-response replay must return committed state');
assert.equal(effectSnapshot(),'9.000|1|3','dispatch replay must not duplicate inventory effects');
assert.throws(()=>transition({op:'transition-dispatch-001',action:'undispatch'}),/different request|operation ID/i);
assert.equal(transition({op:'transition-undispatch-001',action:'undispatch'}),'pending');
assert.equal(effectSnapshot(),'10.000|2|4');

const concurrentDispatchSql=`SELECT (public.transition_table_item_v2('${I.tenant}','${I.branch}','${concurrent[0]}','transition-dispatch-concurrent','dispatch')).status::text`;
const runDispatch=()=>execAsync('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${I.waiter}';${concurrentDispatchSql};COMMIT;`],{env:conn.env,encoding:'utf8'}).then(({stdout})=>stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
assert.deepEqual(await Promise.all([runDispatch(),runDispatch()]),['dispatched','dispatched']);
assert.equal(effectSnapshot(),'9.000|3|5','concurrent identical dispatches must converge to one inventory effect');
assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${I.tenant}' AND action LIKE 'table_item_transition.%'`),'5');

for(const privilege of ['UPDATE','DELETE'])
  assert.equal(sql(`SELECT has_table_privilege('authenticated','public.table_orders','${privilege}')`),'f',`direct table-order ${privilege} must be revoked`);
assert.equal(sql(`SELECT has_function_privilege('authenticated','public.send_table_order_to_cashier(uuid)','EXECUTE')`),'f');
assert.throws(()=>authAs(I.manager,`UPDATE public.table_orders SET status='cancelled' WHERE id='${I.order}'`,'direct order status'),/permission denied/i);

const lifecycle=({actor=I.waiter,branch=I.branch,op,action='send_to_cashier'}={})=>authAs(actor,
`SELECT (public.transition_table_order_lifecycle_v2('${I.tenant}','${branch}','${I.order}','${op}','${action}')).status::text`,op);
const lifecycleSnapshot=()=>sql(`SELECT
(SELECT status::text FROM public.table_orders WHERE id='${I.order}')||'|'||
(SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.center}' AND product_id='${I.product}')||'|'||
(SELECT count(*) FROM public.inventory_movements WHERE reference_id='${I.order}')||'|'||
(SELECT count(*) FROM public.operation_log WHERE tenant_id='${I.tenant}' AND operation_type='transition_table_order_lifecycle_v2')`);

const beforeLifecycle=lifecycleSnapshot();
assert.throws(()=>lifecycle({actor:I.otherWaiter,op:'lifecycle-unassigned-001'}),/forbidden|permission/i);
assert.throws(()=>lifecycle({actor:I.outsider,branch:I.otherBranch,op:'lifecycle-wrong-branch-001'}),/scope|forbidden|permission/i);
assert.throws(()=>lifecycle({actor:I.kitchen,op:'lifecycle-kitchen-001'}),/forbidden|permission/i);
assert.equal(lifecycleSnapshot(),beforeLifecycle,'denied lifecycle requests must have zero order, inventory, or journal effect');

const concurrentCashierSql=`SELECT (public.transition_table_order_lifecycle_v2('${I.tenant}','${I.branch}','${I.order}','lifecycle-cashier-concurrent','send_to_cashier')).status::text`;
const runCashier=()=>execAsync('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${I.waiter}';${concurrentCashierSql};COMMIT;`],{env:conn.env,encoding:'utf8'}).then(({stdout})=>stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
assert.deepEqual(await Promise.all([runCashier(),runCashier()]),['sent_to_cashier','sent_to_cashier']);
assert.equal(lifecycleSnapshot(),'sent_to_cashier|9.000|3|1','concurrent cashier transitions must converge to one lifecycle effect');
assert.equal(lifecycle({op:'lifecycle-cashier-concurrent'}),'sent_to_cashier','lost-response lifecycle replay must return committed state');
assert.throws(()=>lifecycle({op:'lifecycle-cashier-concurrent',action:'cancel'}),/different request|operation ID/i);
assert.equal(lifecycleSnapshot(),'sent_to_cashier|9.000|3|1');

const concurrentCancelSql=`SELECT (public.transition_table_order_lifecycle_v2('${I.tenant}','${I.branch}','${I.order}','lifecycle-cancel-001','cancel')).status::text`;
const runCancel=()=>execAsync('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${I.waiter}';${concurrentCancelSql};COMMIT;`],{env:conn.env,encoding:'utf8'}).then(({stdout})=>stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
assert.deepEqual(await Promise.all([runCancel(),runCancel()]),['cancelled','cancelled']);
assert.equal(lifecycleSnapshot(),'cancelled|10.000|4|2','cancellation must reverse dispatch inventory exactly once');
assert.equal(sql(`SELECT count(*) FROM public.table_order_items WHERE order_id='${I.order}' AND status<>'cancelled'`),'0');
assert.equal(lifecycle({op:'lifecycle-cancel-001',action:'cancel'}),'cancelled');
assert.equal(lifecycleSnapshot(),'cancelled|10.000|4|2','cancellation replay must not repeat inventory effects');
assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${I.tenant}' AND action LIKE 'table_order_lifecycle.%'`),'2');

console.log('PASS: table-item, kitchen and order-lifecycle writes are atomic, branch/role scoped and exactly-once; inventory effects converge and denied calls have zero effect.');
