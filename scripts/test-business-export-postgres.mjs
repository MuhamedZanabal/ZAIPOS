import assert from 'node:assert/strict';
import { connection, query, literal } from './postgres-recovery.mjs';
if(!process.env.POSTGRES_ADMIN_URL)throw new Error('POSTGRES_ADMIN_URL required for disposable export contract database');
const conn=connection(process.env.POSTGRES_ADMIN_URL);
const sql=(s)=>query(conn,s);
const I={tenant:'1f000000-0000-0000-0000-000000000001',otherTenant:'1f000000-0000-0000-0000-000000000002',branch:'2f000000-0000-0000-0000-000000000001',otherBranch:'2f000000-0000-0000-0000-000000000002',manager:'3f000000-0000-0000-0000-000000000001',cashier:'3f000000-0000-0000-0000-000000000002',center:'4f000000-0000-0000-0000-000000000001'};
const signature='public.export_business_data_v1(uuid,uuid,text)';
assert.equal(sql(`SELECT to_regprocedure('${signature}') IS NOT NULL`),'t','Authoritative snapshot export RPC must exist');
assert.equal(sql(`SELECT has_function_privilege('anon','${signature}','EXECUTE')`),'f');
sql(`
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${I.manager}','export-manager@zaipos.test','{}'),('${I.cashier}','export-cashier@zaipos.test','{}');
 INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES('${I.tenant}','Export Tenant','export-contract','BHD',10,false),('${I.otherTenant}','Other Export Tenant','export-contract-other','BHD',10,false);
 INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${I.branch}','${I.tenant}','Export Branch','active'),('${I.otherBranch}','${I.otherTenant}','Other Branch','active');
 INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES('${I.manager}','${I.tenant}','${I.branch}','manager'),('${I.cashier}','${I.tenant}','${I.branch}','cashier');
 INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES('${I.center}','${I.tenant}','${I.branch}','Export Center','warehouse','active');
 INSERT INTO public.products(id,tenant_id,name,sku,product_type,price,cost,tax_rate,status)
 SELECT ('6f000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'${I.tenant}',CASE WHEN i=1 THEN '=SUM(1,2)'||chr(10)||'حليب' ELSE 'Product '||i END,'EXPORT-'||i,'simple',1.251,0.501,10,'active' FROM generate_series(1,1501) i;
 INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status) VALUES('6f000000-0000-0000-0000-999999999999','${I.otherTenant}','Other tenant item','simple',1,1,10,'active');
 INSERT INTO public.product_barcodes(tenant_id,product_id,barcode,barcode_type,is_primary,sort_order) VALUES('${I.tenant}','6f000000-0000-0000-0000-000000000001','ABC|DEF','internal',true,0);
 INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity)
 SELECT '${I.tenant}','${I.branch}','${I.center}',id,0.001 FROM public.products WHERE tenant_id='${I.tenant}';
`);
const call=(domain,tenant=I.tenant,branch=I.branch)=>`SELECT public.export_business_data_v1('${tenant}','${branch}',${literal(domain)})::text`;
const asUser=(user,statement)=>sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${user}'; ${statement}; COMMIT;`);
const fingerprint=()=>sql(`SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM public.products p WHERE tenant_id='${I.tenant}'`);
const before=fingerprint();const started=performance.now();
const catalogue=JSON.parse(asUser(I.manager,call('catalogue')));
assert.equal(catalogue.schema,'zaipos.business-export.v1');assert.equal(catalogue.row_count,1501);assert.equal(catalogue.records.length,1501);
assert.equal(catalogue.tenant_id,I.tenant);assert.equal(catalogue.branch_id,I.branch);assert.ok(Number.isFinite(Date.parse(catalogue.exported_at)));
assert.equal(catalogue.records[0].price_fils,'1251');assert.equal(catalogue.records[0].cost_fils,'501');
assert.equal(catalogue.records[0].name,'=SUM(1,2)\nحليب');assert.equal(catalogue.records[0].product_barcodes[0].barcode,'ABC|DEF');
assert.deepEqual(catalogue.records,JSON.parse(asUser(I.manager,call('catalogue'))).records);
const stock=JSON.parse(asUser(I.manager,call('inventory')));
assert.equal(stock.records.length,1501);assert.ok(stock.records.every(row=>row.quantity==='0.001'&&row.center_id===I.center));
assert.equal(before,fingerprint());
for(const [user,statement] of [[I.cashier,call('catalogue')],[I.manager,call('catalogue',I.otherTenant,I.otherBranch)],[I.manager,call('inventory',I.tenant,I.otherBranch)],[I.manager,call('customers')]])assert.throws(()=>asUser(user,statement));
sql(`UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id='${I.manager}'`);assert.throws(()=>asUser(I.manager,call('catalogue')));
sql(`UPDATE auth.users SET banned_until=NULL WHERE id='${I.manager}'; DELETE FROM public.user_roles WHERE user_id='${I.manager}'`);assert.throws(()=>asUser(I.manager,call('catalogue')));
console.log(`PASS: scalar full-schema exports preserve 1501 records, string fils/quantities, Unicode/barcodes, deterministic ordering and read-only state; cashier/cross-tenant/wrong-branch/banned/revoked access denied. Contract elapsed ${(performance.now()-started).toFixed(0)} ms (CI fixture, not production SLA).`);
