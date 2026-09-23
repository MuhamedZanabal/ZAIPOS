import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { connection,query } from './postgres-recovery.mjs';
if(!process.env.POSTGRES_ADMIN_URL)throw new Error('Disposable contract database required');
const conn=connection(process.env.POSTGRES_ADMIN_URL);const sql=s=>query(conn,s);
const I={tenant:'a6000000-0000-0000-0000-000000000001',branch:'b6000000-0000-0000-0000-000000000001',otherBranch:'b6000000-0000-0000-0000-000000000002',cashier:'c6000000-0000-0000-0000-000000000001',otherCashier:'c6000000-0000-0000-0000-000000000002',manager:'c6000000-0000-0000-0000-000000000003',register:'d6000000-0000-0000-0000-000000000001',session:'e6000000-0000-0000-0000-000000000001',deviceUid:'CASH-AUTHORITY-TERMINAL'};
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${I.cashier}','cash-contract@zaipos.test','{}'),('${I.otherCashier}','cash-other@zaipos.test','{}'),('${I.manager}','cash-manager@zaipos.test','{}');
 INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES('${I.tenant}','Cash Authority','cash-authority-contract','BHD',10,false);
 INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${I.branch}','${I.tenant}','Cash Branch','active'),('${I.otherBranch}','${I.tenant}','Other Cash Branch','active');
 INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES('${I.cashier}','${I.tenant}','${I.branch}','cashier'),('${I.otherCashier}','${I.tenant}','${I.otherBranch}','cashier'),('${I.manager}','${I.tenant}','${I.branch}','manager');
 INSERT INTO public.cash_registers(id,tenant_id,branch_id,name,status) VALUES('${I.register}','${I.tenant}','${I.branch}','Cash Register','active');
 INSERT INTO public.cash_sessions(id,tenant_id,branch_id,register_id,user_id,status,opening_amount) VALUES('${I.session}','${I.tenant}','${I.branch}','${I.register}','${I.cashier}','open',10.000);`);
const asUser=(user,statement,commit=false)=>sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${user}'; ${statement}; ${commit?'COMMIT':'ROLLBACK'};`);
const approval=asUser(I.manager,`SELECT public.approve_device_enrollment('${I.tenant}','${I.branch}','${I.deviceUid}')::text`,true);
const credential=sql(`SET ROLE service_role; SELECT credential FROM public.activate_device_enrollment('${approval}','1.0.0','windows'); RESET ROLE;`);
assert.match(credential,/^[a-f0-9]{64}$/i);
const record=(reference,amount,reason)=>`SELECT public.record_cash_movement_v3_device('${I.tenant}','${I.branch}','${I.session}','in',${amount},'${reason}','${reference}','${I.deviceUid}','${credential}')::text`;
const failures=[];
const deny=(label,user,statement)=>{try{const result=asUser(user,statement);if(result){failures.push(label);console.log('UNSAFE: '+label);}}catch{/* Rejection or a zero-row RLS result is safe. */}};
deny('cashier can directly rewrite authoritative till totals',I.cashier,`UPDATE public.cash_sessions SET total_cash=98.765 WHERE id='${I.session}' RETURNING id`);
deny('cashier can directly create unaudited cash movements',I.cashier,`INSERT INTO public.cash_movements(tenant_id,session_id,type,amount,reason,user_id) VALUES('${I.tenant}','${I.session}','in',1,'forged','${I.cashier}') RETURNING id`);
deny('cashier can bypass the replay authority with the legacy movement RPC',I.cashier,`SELECT public.add_cash_movement('${I.session}','in',1.001,'Legacy bypass')`);
deny('authenticated caller retains credential-less cash movement',I.cashier,`SELECT public.record_cash_movement_v2('${I.session}','in',1.001,'Verified extra float','AUTH-LEGACY-001')::text`);
deny('wrong-branch cashier can record cash against another branch',I.otherCashier,record('AUTH-WRONG-001','1.001','Wrong branch cash'));
deny('fractional fils are silently rounded',I.cashier,record('AUTH-SUBFILS-001','0.0001','Sub-fils cash'));
assert.equal(failures.length,0,failures.join('; '));
const movement=asUser(I.cashier,record('AUTH-FLOAT-001','1.001','Verified extra float'),true);
assert.match(movement,/^[a-f0-9-]{36}$/);assert.equal(sql(`SELECT total_in_fils::text FROM public.cash_sessions WHERE id='${I.session}'`),'1001');
assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE entity_id='${movement}' AND action='cash.movement_recorded'`),'1');
deny('cashier can alter historical cash movement evidence',I.cashier,`UPDATE public.cash_movements SET amount=9 WHERE id='${movement}' RETURNING id`);
deny('cashier can delete historical cash movement evidence',I.cashier,`DELETE FROM public.cash_movements WHERE id='${movement}' RETURNING id`);
// Pause insertion after the v2 command reaches the primitive and acquires its
// session lock; a concurrent close must wait and include the movement in its
// immutable reconciliation.
sql(`CREATE FUNCTION public.cash_contract_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason='Concurrent verified float' THEN PERFORM pg_sleep(2); END IF; RETURN NEW; END; $$;
CREATE TRIGGER cash_contract_pause BEFORE INSERT ON public.cash_movements FOR EACH ROW EXECUTE FUNCTION public.cash_contract_pause();`);
const exec=promisify(execFile);
const pending=exec('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${I.cashier}'; ${record('AUTH-CONCURRENT-001','1.000','Concurrent verified float')}; COMMIT;`],{env:{...conn.env,PGAPPNAME:'zaipos-cash-concurrency-contract'},encoding:'utf8'});
let paused=false;
for(let attempt=0;attempt<40;attempt++){
 if(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='zaipos-cash-concurrency-contract' AND wait_event='PgSleep'")==='1'){paused=true;break;}
 await new Promise(resolve=>setTimeout(resolve,25));
}
assert.ok(paused,'Movement must reach the controlled race boundary');
asUser(I.cashier,`SELECT (public.close_cash_session('${I.session}',12.001,'Concurrent close',0,0,0)).id`,true);
await pending;
sql('DROP TRIGGER cash_contract_pause ON public.cash_movements; DROP FUNCTION public.cash_contract_pause()');
assert.equal(sql(`SELECT difference_fils::text FROM public.cash_sessions WHERE id='${I.session}'`),'0');
assert.equal(sql(`SELECT expected_amount_fils::text FROM public.cash_sessions WHERE id='${I.session}'`),'12001');
deny('closed session accepts new movements',I.cashier,record('AUTH-CLOSED-001','1','Closed session cash'));
assert.equal(failures.length,0,failures.join('; '));
console.log('PASS: direct cash DML/legacy RPC denied; enrolled-device exact-fils movement is audited; concurrent close includes its effect and closed sessions reject new movements.');
