import assert from 'node:assert/strict';
import {connection} from './postgres-recovery.mjs';
import {execFileSync} from 'node:child_process';
if(!process.env.POSTGRES_ADMIN_URL)throw new Error('Disposable contract database required');
const conn=connection(process.env.POSTGRES_ADMIN_URL);
// This fixture contains only disposable test identities. Keep production backup
// diagnostic redaction intact while checking the actual rejection reason here.
const sql=s=>{
 try {return execFileSync('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',s],{env:conn.env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
 catch(error){throw new Error(String(error.stderr ?? 'PostgreSQL test command failed'));}
};
const tenant='a9000000-0000-0000-0000-000000000001',branch='b9000000-0000-0000-0000-000000000001',user='c9000000-0000-0000-0000-000000000001';
const operation='d9000000-0000-0000-0000-000000000001';
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${user}','cash-lifecycle@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES('${tenant}','Session Lifecycle','session-lifecycle-contract','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${branch}','${tenant}','Session Branch','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES('${user}','${tenant}','${branch}','cashier');`);
const auth=s=>sql(`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${user}';${s};COMMIT;`);
const v2=sql("SELECT to_regprocedure('public.apply_cash_session_v2(uuid,jsonb,boolean)') IS NOT NULL")==='t';
const request={kind:'open',tenant_id:tenant,branch_id:branch,register_id:null,opening_amount:'1.001'};
const apply=(id,payload,cancel=false)=>`SELECT public.apply_cash_session_v2('${id}','${JSON.stringify(payload).replaceAll("'","''")}'::jsonb,${cancel})`;
const open=()=>v2?JSON.parse(auth(apply(operation,request))).session_id:auth(`SELECT (public.open_cash_session('${tenant}','${branch}',1.001,NULL)).id`);
const first=open();
// Model a committed opening whose reply was lost; another authorized actor can
// subsequently close it before the original terminal recovers its request.
sql(`BEGIN;SET LOCAL request.jwt.claim.sub='${user}';SELECT public.close_cash_session('${first}',1.001,NULL,0,0,0);COMMIT;`);
assert.equal(open(),first,'A lost opening response replay after closure must return the original session, never open a second till');
assert.equal(sql(`SELECT count(*) FROM public.cash_sessions WHERE branch_id='${branch}'`),'1');
console.log('PASS: opening replay preserves the original closed session.');
// From here exercise the new public boundary without fallback.
assert.equal(v2,true,'The durable lifecycle authority must exist');
const call=(id,payload,cancel=false)=>JSON.parse(auth(apply(id,payload,cancel)));
const {randomUUID}=await import('node:crypto');
const {execFile}=await import('node:child_process');
const {promisify}=await import('node:util');
const exec=promisify(execFile);
const race=async statements=>Promise.all(statements.map(statement=>exec('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${user}';${statement};COMMIT;`],{env:conn.env,encoding:'utf8'}).then(r=>JSON.parse(r.stdout.trim()))));
const count=()=>sql(`SELECT count(*) FROM public.cash_sessions WHERE branch_id='${branch}'`);
assert.equal(call(operation,request,true).session_id,first,'Cancellation observes an already committed opening without undoing it');
assert.throws(()=>call(operation,{...request,opening_amount:'1.002'}),/different actor or payload/);
const other='c9000000-0000-0000-0000-000000000002';
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${other}','cash-lifecycle-other@zaipos.test','{}');INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES('${other}','${tenant}','${branch}','cashier')`);
assert.throws(()=>sql(`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${other}';${apply(operation,request)};COMMIT;`),/different actor or payload/);
sql(`UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id='${user}'`);
assert.throws(()=>call(operation,request),/User is not active/);
sql(`UPDATE auth.users SET banned_until=NULL,deleted_at=now() WHERE id='${user}'`);
assert.throws(()=>call(operation,request),/User is not active/);
sql(`UPDATE auth.users SET deleted_at=NULL WHERE id='${user}';UPDATE public.branches SET status='inactive' WHERE id='${branch}'`);
assert.throws(()=>call(operation,request),/Branch is not active/);
sql(`UPDATE public.branches SET status='active' WHERE id='${branch}'`);
sql(`DELETE FROM public.user_roles WHERE user_id='${user}' AND tenant_id='${tenant}'`);
assert.throws(()=>call(operation,request),/Forbidden/);
sql(`INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES('${user}','${tenant}','${branch}','cashier');INSERT INTO public.employees(tenant_id,branch_id,user_id,full_name,status) VALUES('${tenant}','${branch}','${user}','Lifecycle cashier','inactive')`);
assert.throws(()=>call(operation,request),/Employee is not active/);
sql(`UPDATE public.employees SET status='active' WHERE user_id='${user}' AND tenant_id='${tenant}'`);
assert.throws(()=>sql(`BEGIN;SET LOCAL ROLE authenticated;${apply(operation,request)};COMMIT;`),/Not authenticated/);
assert.throws(()=>sql(`BEGIN;SET LOCAL ROLE anon;${apply(operation,request)};COMMIT;`),/permission denied/);
const branch2='b9000000-0000-0000-0000-000000000002';
sql(`INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${branch2}','${tenant}','Another Branch','active');INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES('${user}','${tenant}','${branch2}','cashier')`);
assert.throws(()=>call(operation,{...request,branch_id:branch2}),/different actor or payload/);
assert.throws(()=>call(randomUUID(),{...request,tenant_id:'a9000000-0000-0000-0000-000000000002'}),/Forbidden/);
for(const amount of ['1.0001','-0.001','NaN','Infinity','',null,1.001]) {
 assert.throws(()=>call(randomUUID(),{...request,opening_amount:amount}),/exact-fils/);
}
assert.throws(()=>call(randomUUID(),{...request,unexpected:true}),/request fields/);
const cancelled=randomUUID();
assert.equal(call(cancelled,request,true).state,'cancelled');
assert.equal(call(cancelled,request).state,'cancelled','A late execution cannot resurrect a cancelled opening');
assert.equal(count(),'1');
const openId=randomUUID();
const openings=await race(Array.from({length:4},()=>apply(openId,request)));
assert.ok(openings.every(r=>r.session_id===openings[0].session_id && r.state==='recorded'));
assert.equal(count(),'2','Concurrent duplicate opening creates exactly one additional session');
const session=openings[0].session_id;
const closing={kind:'close',tenant_id:tenant,branch_id:branch,session_id:session,counted_cash:'1.001',counted_card:'0.000',counted_transfer:'0.000',counted_qr:'0.000',notes:'Count verified'};
for(const field of ['counted_cash','counted_card','counted_transfer','counted_qr']) {
 const missing={...closing};delete missing[field];assert.throws(()=>call(randomUUID(),missing),/request fields/);
 assert.throws(()=>call(randomUUID(),{...closing,[field]:'0.0001'}),/exact-fils/);
}
assert.throws(()=>call(randomUUID(),{...closing,branch_id:branch2}),/outside this scope/);
const cancelClose=randomUUID();
assert.equal(call(cancelClose,closing,true).state,'cancelled');
assert.equal(call(cancelClose,closing).state,'cancelled');
assert.equal(sql(`SELECT status FROM public.cash_sessions WHERE id='${session}'`),'open');
const closeId=randomUUID();
const closings=await race(Array.from({length:4},()=>apply(closeId,closing)));
assert.ok(closings.every(r=>r.state==='recorded' && r.session_id===session));
const snapshot=sql(`SELECT row_to_json(s) FROM public.cash_sessions s WHERE id='${session}'`);
assert.equal(call(closeId,closing,true).state,'recorded');
assert.throws(()=>call(closeId,{...closing,counted_cash:'2.002'}),/different actor or payload/);
assert.throws(()=>call(randomUUID(),closing),/already closed/);
assert.equal(sql(`SELECT row_to_json(s) FROM public.cash_sessions s WHERE id='${session}'`),snapshot);
assert.equal(sql(`SELECT difference_fils FROM public.cash_sessions WHERE id='${session}'`),'0');
assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE entity_id='${session}' AND action='cash_session.closed'`),'1');
const later=call(randomUUID(),request).session_id;
assert.notEqual(later,session);assert.equal(call(openId,request).session_id,session);
assert.equal(call(closeId,closing).session_id,session,'Recover an earlier close after a later opening');
assert.equal(sql(`SELECT status FROM public.cash_sessions WHERE id='${later}'`),'open');
call(randomUUID(),{...closing,session_id:later});
// Execute/cancel compete for the SAME identity. Both must observe one outcome.
const mixedId=randomUUID();
const mixed=await race([apply(mixedId,request),apply(mixedId,request,true),apply(mixedId,request)]);
assert.ok(mixed.every(r=>JSON.stringify(r)===JSON.stringify(mixed[0])));
assert.equal(sql(`SELECT count(*) FROM public.cash_session_operations WHERE id='${mixedId}'`),'1');
if(mixed[0].state==='recorded')call(randomUUID(),{...closing,session_id:mixed[0].session_id});
// Audit failure after the primitive ran must roll back the entire new operation.
sql(`CREATE FUNCTION public.cash_lifecycle_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='cash_session.operation_recorded' AND NEW.tenant_id='${tenant}' THEN RAISE EXCEPTION 'Controlled lifecycle audit failure'; END IF; RETURN NEW; END; $$;CREATE TRIGGER cash_lifecycle_audit_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.cash_lifecycle_audit_failure();`);
const rollbackId=randomUUID(),before=count();
assert.throws(()=>call(rollbackId,request),/Controlled lifecycle audit failure/);
assert.equal(count(),before);assert.equal(sql(`SELECT count(*) FROM public.cash_session_operations WHERE id='${rollbackId}'`),'0');
sql('DROP TRIGGER cash_lifecycle_audit_failure ON public.audit_logs');
const rollbackSession=call(rollbackId,request).session_id;
sql('CREATE TRIGGER cash_lifecycle_audit_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.cash_lifecycle_audit_failure()');
const rollbackClose=randomUUID();
assert.throws(()=>call(rollbackClose,{...closing,session_id:rollbackSession}),/Controlled lifecycle audit failure/);
assert.equal(sql(`SELECT status FROM public.cash_sessions WHERE id='${rollbackSession}'`),'open');
assert.equal(sql(`SELECT count(*) FROM public.cash_session_operations WHERE id='${rollbackClose}'`),'0');
sql('DROP TRIGGER cash_lifecycle_audit_failure ON public.audit_logs; DROP FUNCTION public.cash_lifecycle_audit_failure()');
call(rollbackClose,{...closing,session_id:rollbackSession});
assert.throws(()=>auth(`SELECT public.open_cash_session('${tenant}','${branch}',0,NULL)`),/permission denied/);
assert.throws(()=>auth(`SELECT public.close_cash_session('${first}',0,NULL,0,0,0)`),/permission denied/);
assert.throws(()=>auth(`DELETE FROM public.cash_session_operations WHERE id='${operation}'`),/permission denied/);
assert.throws(()=>sql(`UPDATE public.cash_session_operations SET state='cancelled' WHERE id='${operation}'`),/immutable/);
assert.throws(()=>sql(`DELETE FROM public.cash_session_operations WHERE id='${operation}'`),/immutable/);
assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE entity='cash_session_operations' AND entity_id='${openId}'`),'1');
console.log('PASS: lifecycle payload/actor/scope binding, current authorization, concurrency, cancel convergence, historical replay, exact counts, audit rollback and immutable evidence.');
