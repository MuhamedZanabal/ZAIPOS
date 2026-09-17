import assert from 'node:assert/strict';
import {connection,query} from './postgres-recovery.mjs';
if(!process.env.POSTGRES_ADMIN_URL)throw new Error('Disposable contract database required');
const conn=connection(process.env.POSTGRES_ADMIN_URL),sql=s=>query(conn,s);
const tenant='a9000000-0000-0000-0000-000000000001',branch='b9000000-0000-0000-0000-000000000001',user='c9000000-0000-0000-0000-000000000001';
const operation='d9000000-0000-0000-0000-000000000001';
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${user}','cash-lifecycle@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES('${tenant}','Session Lifecycle','session-lifecycle-contract','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES('${branch}','${tenant}','Session Branch','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES('${user}','${tenant}','${branch}','cashier');`);
const auth=s=>sql(`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='${user}';${s};COMMIT;`);
const v2=sql("SELECT to_regprocedure('public.apply_cash_session_v2(uuid,jsonb,boolean)') IS NOT NULL")==='t';
const request={kind:'open',tenant_id:tenant,branch_id:branch,register_id:null,opening_amount:'1.001'};
const apply=(id,payload,cancel=false)=>`SELECT public.apply_cash_session_v2('${id}','${JSON.stringify(payload)}'::jsonb,${cancel})`;
const open=()=>v2?JSON.parse(auth(apply(operation,request))).session_id:auth(`SELECT (public.open_cash_session('${tenant}','${branch}',1.001,NULL)).id`);
const first=open();
// Model a committed opening whose reply was lost; another authorized actor can
// subsequently close it before the original terminal recovers its request.
sql(`BEGIN;SET LOCAL request.jwt.claim.sub='${user}';SELECT public.close_cash_session('${first}',1.001,NULL,0,0,0);COMMIT;`);
assert.equal(open(),first,'A lost opening response replay after closure must return the original session, never open a second till');
assert.equal(sql(`SELECT count(*) FROM public.cash_sessions WHERE branch_id='${branch}'`),'1');
console.log('PASS: opening replay preserves the original closed session.');
