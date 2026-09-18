import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {connection} from './postgres-recovery.mjs';
if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable contract database required');
const conn=connection(process.env.POSTGRES_ADMIN_URL);
const sql=statement=>{
 try {return execFileSync('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',statement],{env:conn.env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
 catch(error){throw new Error(String(error.stderr ?? 'PostgreSQL fixture command failed'));}
};
const tenant='aa000000-0000-0000-0000-000000000601',branch='bb000000-0000-0000-0000-000000000601',actor='cc000000-0000-0000-0000-000000000601',session='dd000000-0000-0000-0000-000000000601',center='ee000000-0000-0000-0000-000000000601',product='ff000000-0000-0000-0000-000000000601';
const original='SEC004-original-terminal',replacement='SEC004-copied-renderer-new-uid';
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${actor}','device-boundary@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock) VALUES('${tenant}','Device Boundary','device-boundary-contract','BHD',10,false,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${branch}','${tenant}','Device Boundary','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES('${actor}','${tenant}','${branch}','cashier');
INSERT INTO public.cash_sessions(id,tenant_id,branch_id,user_id,status) VALUES('${session}','${tenant}','${branch}','${actor}','open');
INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES('${center}','${tenant}','${branch}','Device POS','point_of_sale','active');
INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status) VALUES('${product}','${tenant}','Device Test Product','simple',1.000,0.500,0,'active');
INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES('${tenant}','${branch}','${center}','${product}',2.000);`);
const auth=s=>sql(`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${actor}';${s};COMMIT;`);
const heartbeat=uid=>`SELECT (public.register_device_heartbeat('${tenant}','${branch}','${uid}','1.0.0','win32','stable','current','{}')).id`;
const device=auth(heartbeat(original));
sql(`UPDATE public.devices SET revoked_at=now() WHERE id='${device}'`);
assert.throws(()=>auth(heartbeat(original)),/revoked/i,'Existing heartbeat revocation must still work');
let replacementAccepted=false,checkoutAccepted=false;
try {auth(heartbeat(replacement));replacementAccepted=true;} catch(error) {if(!/enroll|device|authoriz|forbidden|permission/i.test(error.message))throw error;}
const items=JSON.stringify([{product_id:product,quantity:'1.000',discount_fils:0}]);
const payments=JSON.stringify([{method:'cash',amount_fils:1000,reference:null}]);
try {
 auth(`SELECT public.checkout_sale_v2('${tenant}','${branch}','${items}','${payments}',0,NULL,NULL,'pos',0,NULL,'${original}:checkout-after-revocation','${session}')`);
 checkoutAccepted=true;
} catch(error) {if(!/device|enroll|revok|authoriz|permission/i.test(error.message))throw error;}
const persisted={sales:Number(sql(`SELECT count(*) FROM public.sales WHERE tenant_id='${tenant}'`)),cash_fils:sql(`SELECT total_cash_fils FROM public.cash_sessions WHERE id='${session}'`),stock:sql(`SELECT quantity FROM public.inventory_stocks WHERE inventory_center_id='${center}' AND product_id='${product}'`),revoked:sql(`SELECT revoked_at IS NOT NULL FROM public.devices WHERE id='${device}'`)};
if(checkoutAccepted){assert.equal(persisted.sales,1);assert.equal(persisted.cash_fils,'1000');assert.equal(persisted.stock,'1.000');}
else {assert.equal(persisted.sales,0);assert.equal(persisted.cash_fils,'0');assert.equal(persisted.stock,'2.000');}
assert.equal(persisted.revoked,'t');
console.log('SEC004_REPRODUCTION '+JSON.stringify({sameUidHeartbeatRejected:true,replacementAccepted,checkoutAccepted,persisted}));
assert.equal(replacementAccepted,false,'A cashier-controlled replacement UID cannot establish trusted enrollment');
assert.equal(checkoutAccepted,false,'A revoked terminal must not submit a new checkout without valid device authority');
console.log('PASS: trusted device boundary rejects replacement enrollment and revoked-terminal checkout.');
