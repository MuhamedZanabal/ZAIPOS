import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable contract database required');
const conn=connection(process.env.POSTGRES_ADMIN_URL);
const sql=(statement,stage='cash-session contract')=>{try{return execFileSync('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',statement],{env:conn.env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}catch(error){throw new Error(`${stage}: ${String(error.stderr??error.message).trim()}`);}};
const authAs=(user,statement,stage)=>sql(`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${user}';${statement};COMMIT;`,stage);
const I={tenant:'a9000000-0000-0000-0000-000000000001',branch:'b9000000-0000-0000-0000-000000000001',otherBranch:'b9000000-0000-0000-0000-000000000002',manager:'c9000000-0000-0000-0000-000000000001'};
const uid='cash-session-terminal';
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${I.manager}','cash-session-device@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES('${I.tenant}','Cash Session Device','cash-session-device','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${I.branch}','${I.tenant}','Cash Branch','active'),('${I.otherBranch}','${I.tenant}','Other Cash Branch','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES('${I.manager}','${I.tenant}','${I.branch}','manager');`);
const approval=authAs(I.manager,`SELECT public.approve_device_enrollment('${I.tenant}','${I.branch}','${uid}')`,'device approval');
const [deviceId,credential]=sql(`SET ROLE service_role;SELECT device_id::text||'|'||credential FROM public.activate_device_enrollment('${approval}','1.0.0','windows');RESET ROLE;`,'device activation').split('|');
assert.match(credential,/^[a-f\d]{64}$/i);

const open=(amount='1.001',operation='cash-open-operation-001',branch=I.branch,device=uid,secret=credential)=>`SELECT public.open_cash_session_v2_device('${I.tenant}','${branch}',${amount},NULL,'${operation}','${device}','${secret}')::text`;
const snapshot=()=>sql(`SELECT (SELECT count(*) FROM public.cash_sessions WHERE tenant_id='${I.tenant}')||'|'||(SELECT count(*) FROM public.audit_logs WHERE tenant_id='${I.tenant}' AND action='cash_session.opened')||'|'||(SELECT count(*) FROM public.cash_session_device_operations WHERE tenant_id='${I.tenant}')`);
assert.equal(sql(`SELECT has_function_privilege('authenticated','public.open_cash_session(uuid,uuid,numeric,uuid)','EXECUTE')`),'f');
assert.equal(sql(`SELECT has_function_privilege('authenticated','public.close_cash_session(uuid,numeric,text,numeric,numeric,numeric)','EXECUTE')`),'f');
assert.equal(sql(`SELECT has_table_privilege('authenticated','public.cash_session_device_operations','SELECT')`),'f');
assert.throws(()=>authAs(I.manager,`SELECT (public.open_cash_session('${I.tenant}','${I.branch}',1.001,NULL)).id`,'legacy opening'),/permission denied/i);
for(const [label,call] of [['missing credential',open('1.001','cash-open-missing',I.branch,uid,'')],['copied credential',open('1.001','cash-open-copied',I.branch,'copied-device',credential)],['wrong branch',open('1.001','cash-open-branch',I.otherBranch,uid,credential)]]) assert.throws(()=>authAs(I.manager,call,label),/credential|authoriz|scope|permission/i,label);
assert.equal(snapshot(),'0|0|0');

const session=authAs(I.manager,open(),'valid opening');
assert.match(session,/^[a-f\d-]{36}$/i);
assert.equal(authAs(I.manager,open(),'lost opening response replay'),session);
assert.equal(snapshot(),'1|1|1');
assert.throws(()=>authAs(I.manager,open('2.000'),'opening payload substitution'),/conflicts with a different request/i);
assert.equal(snapshot(),'1|1|1');

const close=(cash='1.001',operation='cash-close-operation-001',secret=credential)=>`SELECT public.close_cash_session_v2_device('${I.tenant}','${I.branch}','${session}',${cash},NULL,0.000,0.000,0.000,'${operation}','${uid}','${secret}')::text`;
assert.throws(()=>authAs(I.manager,`SELECT (public.close_cash_session('${session}',1.001,NULL,0,0,0)).id`,'legacy closing'),/permission denied/i);
assert.equal(authAs(I.manager,close(),'valid closing'),session);
assert.equal(authAs(I.manager,close(),'lost closing response replay'),session);
assert.equal(sql(`SELECT status||'|'||opening_amount_fils||'|'||difference_fils FROM public.cash_sessions WHERE id='${session}'`),'closed|1001|0');
assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE entity_id='${session}' AND action='cash_session.closed'`),'1');
assert.equal(sql(`SELECT count(*) FROM public.cash_session_device_operations WHERE tenant_id='${I.tenant}'`),'2');
assert.throws(()=>authAs(I.manager,close('1.000'),'closing payload substitution'),/conflicts with a different request/i);

assert.equal(authAs(I.manager,`SELECT public.revoke_device_enrollment('${I.tenant}','${deviceId}','cash session regression')`,'device revocation'),'t');
assert.throws(()=>authAs(I.manager,close(),'revoked replay'),/credential|revok|authoriz/i);
assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE entity_id='${session}' AND action='cash_session.closed'`),'1');
console.log('PASS: cash-session opening and reconciliation require native device authority, replay exactly once, and reject credential or payload substitution with zero extra effects.');
