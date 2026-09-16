import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {connection,query} from './postgres-recovery.mjs';
if(!process.env.POSTGRES_ADMIN_URL)throw new Error('Disposable contract database required');
const conn=connection(process.env.POSTGRES_ADMIN_URL),sql=s=>query(conn,s);
const I={tenant:'a7000000-0000-0000-0000-000000000001',branch:'b7000000-0000-0000-0000-000000000001',other:'b7000000-0000-0000-0000-000000000002',user:'c7000000-0000-0000-0000-000000000001',wrong:'c7000000-0000-0000-0000-000000000002',session:'e7000000-0000-0000-0000-000000000001'};
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${I.user}','cash-replay@zaipos.test','{}'),('${I.wrong}','cash-replay-wrong@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES('${I.tenant}','Cash Replay','cash-replay-contract','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${I.branch}','${I.tenant}','Replay','active'),('${I.other}','${I.tenant}','Other','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES('${I.user}','${I.tenant}','${I.branch}','cashier'),('${I.wrong}','${I.tenant}','${I.other}','cashier');
INSERT INTO public.cash_sessions(id,tenant_id,branch_id,user_id,status,opening_amount) VALUES('${I.session}','${I.tenant}','${I.branch}','${I.user}','open',10.000);`);
const auth=(s,u=I.user)=>`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${u}';${s};COMMIT;`;
const call=(ref='FLOAT-001',amount='1.001',method='record_cash_movement_v2')=>`SELECT public.${method}('${I.session}','in',${amount},'Verified float','${ref}')::text`;
// This probe proves the old retry defect before requiring the replacement RPC.
if(sql("SELECT to_regprocedure('public.record_cash_movement_v2(uuid,text,numeric,text,text)') IS NOT NULL")==='f'){
 const duplicated=sql(`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${I.user}';SELECT public.add_cash_movement('${I.session}','in',1.001,'Same physical float');SELECT public.add_cash_movement('${I.session}','in',1.001,'Same physical float');SELECT total_in_fils FROM public.cash_sessions WHERE id='${I.session}';ROLLBACK;`);
 assert.fail('RED: legacy retry duplicated one physical float; observed response: '+duplicated);
}
const deny=s=>assert.throws(()=>sql(auth(s)));
deny(`SELECT public.add_cash_movement('${I.session}','in',1,'Legacy bypass')`);
deny(call('SUBFILS','0.0001'));
const id=sql(auth(call()));assert.match(id,/^[a-f0-9-]{36}$/);
const peer='c7000000-0000-0000-0000-000000000003';
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${peer}','cash-replay-peer@zaipos.test','{}');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES('${peer}','${I.tenant}','${I.branch}','cashier');`);
assert.throws(()=>sql(auth(call(),peer)),'Another cashier cannot replay the original actor reference');
assert.throws(()=>sql(auth(call('FLOAT-001','1.001','cancel_cash_movement_v2'),peer)),'Another cashier cannot resolve the original actor reference');

// Simulate a lost response, then intervening real business activity.
const later=sql(auth(call('FLOAT-002','2.002')));assert.notEqual(later,id);
const exec=promisify(execFile);
const retries=await Promise.all(Array.from({length:4},()=>exec('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',auth(call())],{env:conn.env,encoding:'utf8'})));
for(const r of retries)assert.equal(r.stdout.trim(),id);
assert.equal(sql(`SELECT total_in_fils FROM public.cash_sessions WHERE id='${I.session}'`),'3003');
assert.equal(sql(`SELECT count(*) FROM public.cash_movements WHERE session_id='${I.session}'`),'2');
deny(call('FLOAT-001','9.999'));
assert.throws(()=>sql(auth(call(),I.wrong)));
assert.equal(sql(auth(call('FLOAT-001','1.001','cancel_cash_movement_v2'))),id,'Cancellation cannot erase a committed movement');
assert.equal(sql(auth(call('FLOAT-CANCEL','4.004','cancel_cash_movement_v2'))),'');
deny(call('FLOAT-CANCEL','4.004'));
const race=await Promise.allSettled([
 exec('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',auth(call('FLOAT-RACE','5.005'))],{env:conn.env,encoding:'utf8'}),
 exec('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',auth(call('FLOAT-RACE','5.005','cancel_cash_movement_v2'))],{env:conn.env,encoding:'utf8'})
]);
assert.equal(race[1].status,'fulfilled');
const raceState=sql(`SELECT state FROM public.cash_movement_operations WHERE tenant_id='${I.tenant}' AND reference='FLOAT-RACE'`);
assert.ok(['recorded','cancelled'].includes(raceState));
assert.equal(sql(`SELECT total_in_fils FROM public.cash_sessions WHERE id='${I.session}'`),raceState==='recorded'?'8008':'3003');
// Transaction failure must roll back both operation claim and money.
assert.throws(()=>sql(auth(`${call('FLOAT-ROLLBACK')};SELECT 1/0`)));
assert.equal(sql(`SELECT count(*) FROM public.cash_movement_operations WHERE tenant_id='${I.tenant}' AND reference='FLOAT-ROLLBACK'`),'0');
sql(`UPDATE public.cash_sessions SET status='closed',closed_at=now() WHERE id='${I.session}'`);
assert.equal(sql(auth(call())),id,'Committed replay survives session closure');
deny(call('FLOAT-CLOSED'));
assert.equal(sql(`SELECT count(*) FROM public.cash_movement_operations WHERE tenant_id='${I.tenant}' AND reference='FLOAT-CLOSED'`),'0');
deny(`UPDATE public.cash_movement_operations SET reference='REWRITE' WHERE tenant_id='${I.tenant}'`);
deny(`DELETE FROM public.cash_movement_operations WHERE tenant_id='${I.tenant}'`);
sql(`DELETE FROM public.user_roles WHERE user_id='${I.user}'`);deny(call());
console.log('PASS: cash replay preserves exact original effects across concurrency, later movements and closed sessions; payload/role substitution denied; cancellation and rollback converge.');
