import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connection, query, literal } from './postgres-recovery.mjs';

// Run only against the disposable fully migrated contract database in CI.
if (!process.env.POSTGRES_ADMIN_URL) throw new Error('POSTGRES_ADMIN_URL is required');
const conn=connection(process.env.POSTGRES_ADMIN_URL);
const ids=Object.fromEntries(['tenant','branch','manager','cashier','center','product'].map((key,index)=>[key,`${index+1}e000000-0000-0000-0000-000000000001`]));
const sql=(statement)=>query(conn,statement);
const userSql=(user,statement)=>`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub=${literal(user)}; ${statement}; COMMIT;`;
const asUser=(user,statement)=>sql(userSql(user,statement));
const reject=(user,statement)=>assert.throws(()=>asUser(user,statement));
sql(`
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 ('${ids.manager}','inventory-retry-manager@zaipos.test','{}'),('${ids.cashier}','inventory-retry-cashier@zaipos.test','{}');
 INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock)
 VALUES('${ids.tenant}','Inventory Retry','inventory-count-retry','BHD',10,false,false);
 INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${ids.branch}','${ids.tenant}','Count Branch','active');
 INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
 ('${ids.manager}','${ids.tenant}','${ids.branch}','manager'),('${ids.cashier}','${ids.tenant}','${ids.branch}','cashier');
 INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status)
 VALUES('${ids.center}','${ids.tenant}','${ids.branch}','Count Center','point_of_sale','active');
 INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status)
 VALUES('${ids.product}','${ids.tenant}','Count Item','simple',1.000,0.500,10,'active');
 INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity)
 VALUES('${ids.tenant}','${ids.branch}','${ids.center}','${ids.product}',5.000);
`);
const call=(op='count-retry-contract-001',quantity='10.001')=>`SELECT public.reconcile_inventory_levels_v2(
 '${ids.tenant}','${ids.branch}','${ids.center}',
 '[{"product_id":"${ids.product}","target_quantity":"${quantity}","effect_key":"sku:COUNT"}]'::jsonb,
 ${literal(op)},'Bulk physical inventory import')::text`;
const stock=()=>sql(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${ids.center}' AND product_id='${ids.product}'`);
const evidence=()=>sql(`SELECT md5(coalesce(jsonb_agg(to_jsonb(m) ORDER BY id)::text,'')) FROM public.inventory_movements m WHERE tenant_id='${ids.tenant}'`);

const first=asUser(ids.manager,call());
assert.match(first,/^[0-9a-f-]{36}$/);assert.equal(stock(),'10.001');
// A later authoritative stock reduction must survive a retry of the old count.
asUser(ids.manager,`SELECT public.record_inventory_batch_v2('${ids.tenant}','${ids.branch}','${ids.center}',
 '[{"product_id":"${ids.product}","movement_type":"waste","quantity":1,"effect_key":"waste-1"}]'::jsonb,
 'count-retry-intervening-movement','Documented intervening stock reduction')`);
assert.equal(stock(),'9.001');const before=evidence();
const exec=promisify(execFile);
const replies=await Promise.all(Array.from({length:4},()=>exec('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',userSql(ids.manager,call())],{env:conn.env,encoding:'utf8'})));
for(const reply of replies)assert.equal(reply.stdout.trim(),first);
assert.equal(stock(),'9.001');assert.equal(evidence(),before);
reject(ids.manager,call('count-retry-contract-001','11.001'));
reject(ids.cashier,call());
assert.equal(stock(),'9.001');assert.equal(evidence(),before);
// A genuinely new count is allowed to apply the same number again.
assert.notEqual(asUser(ids.manager,call('count-retry-contract-002')),first);
assert.equal(stock(),'10.001');
sql(`DELETE FROM public.user_roles WHERE user_id='${ids.manager}'`);
reject(ids.manager,call());
console.log('PASS: full-schema count replay preserves subsequent movement and exact thousandths; four concurrent retries converge; changed payload, cashier and revoked manager are rejected.');
