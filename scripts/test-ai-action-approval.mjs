import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "1e000000-0000-0000-0000-000000000001",
  tenantB: "1e000000-0000-0000-0000-000000000002",
  branchA: "2e000000-0000-0000-0000-000000000001",
  branchB: "2e000000-0000-0000-0000-000000000002",
  cashierA: "3e000000-0000-0000-0000-000000000001",
  managerA: "3e000000-0000-0000-0000-000000000002",
  managerB: "3e000000-0000-0000-0000-000000000003",
};
function psql(args, capture=true){return execFileSync("psql",[dbUrl,"-X","-v","ON_ERROR_STOP=1",...args],{encoding:"utf8",stdio:capture?["ignore","pipe","pipe"]:"inherit"});}
function sql(s){return psql(["-c",s],false);}
function scalar(s){return psql(["-Atq","-c",s]).trim().split(/\r?\n/).filter(Boolean).at(-1)??"";}
function asUser(id,s){return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${id}'; ${s}; COMMIT;`);}
function eq(label,a,e){if(a!==e)throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);}
function reject(label,id,s,p=/forbidden|permission|branch|tenant|self|payload|pending/i){try{asUser(id,s);}catch(e){const m=String(e?.stderr??e?.message??e);if(!p.test(m))throw new Error(`${label}: wrong rejection: ${m}`);return;}throw new Error(`${label}: expected rejection`);}

const requestSig="public.request_ai_action_v1(uuid,text,jsonb,jsonb,text)";
const reviewSig="public.review_ai_action_v1(uuid,boolean,text,text)";
eq("queue exists",scalar("SELECT to_regclass('public.ai_action_requests') IS NOT NULL;"),"t");
eq("request RPC exists",scalar(`SELECT to_regprocedure('${requestSig}') IS NOT NULL;`),"t");
eq("review RPC exists",scalar(`SELECT to_regprocedure('${reviewSig}') IS NOT NULL;`),"t");
for(const role of ["anon","service_role"]){eq(`${role} request denied`,scalar(`SELECT has_function_privilege('${role}','${requestSig}','EXECUTE');`),"f");eq(`${role} review denied`,scalar(`SELECT has_function_privilege('${role}','${reviewSig}','EXECUTE');`),"f");}
eq("authenticated request allowed",scalar(`SELECT has_function_privilege('authenticated','${requestSig}','EXECUTE');`),"t");
eq("authenticated review RPC callable subject to server policy",scalar(`SELECT has_function_privilege('authenticated','${reviewSig}','EXECUTE');`),"t");

sql(`
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 ('${I.cashierA}','ai-action-cashier@zaipos.test','{}'),('${I.managerA}','ai-action-manager@zaipos.test','{}'),('${I.managerB}','ai-action-manager-b@zaipos.test','{}') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
 ('${I.tenantA}','AI Action A','ai-action-a','BHD',10,false),('${I.tenantB}','AI Action B','ai-action-b','BHD',10,false) ON CONFLICT(id) DO NOTHING;
INSERT INTO public.branches(id,tenant_id,name,status) VALUES
 ('${I.branchA}','${I.tenantA}','AI Action Branch A','active'),('${I.branchB}','${I.tenantB}','AI Action Branch B','active') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
 ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),('${I.managerA}','${I.tenantA}','${I.branchA}','manager'),('${I.managerB}','${I.tenantB}','${I.branchB}','manager') ON CONFLICT DO NOTHING;
`);
const payload=`{"product_id":"50000000-0000-0000-0000-000000000001","suggested_quantity":"5.000"}`;
const evidence=`{"source_type":"branch_reporting_snapshot_v1","source_ids":[]}`;
const request=(op,p=payload)=>`SELECT public.request_ai_action_v1('${I.branchA}'::uuid,'inventory.reorder_suggestion','${p}'::jsonb,'${evidence}'::jsonb,'${op}')::text`;
const id=asUser(I.cashierA,request("ai-action-op-1"));
eq("request pending",scalar(`SELECT status FROM public.ai_action_requests WHERE id='${id}'::uuid;`),"pending");
eq("replay same id",asUser(I.cashierA,request("ai-action-op-1")),id);
reject("payload bound request",I.cashierA,request("ai-action-op-1",`{"product_id":"50000000-0000-0000-0000-000000000001","suggested_quantity":"6.000"}`));
reject("requester cannot self approve",I.cashierA,`SELECT public.review_ai_action_v1('${id}'::uuid,true,'approve','ai-review-1')`);
reject("cross tenant manager cannot approve",I.managerB,`SELECT public.review_ai_action_v1('${id}'::uuid,true,'approve','ai-review-2')`);
eq("manager approval",asUser(I.managerA,`SELECT public.review_ai_action_v1('${id}'::uuid,true,'Approved for operator review only','ai-review-3')::text`),id);
eq("approved status",scalar(`SELECT status FROM public.ai_action_requests WHERE id='${id}'::uuid;`),"approved");
eq("no execution columns",scalar(`SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_action_requests' AND column_name IN ('executed_at','execution_result','command_id');`),"0");
eq("request audit",scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='ai.action_requested' AND entity_id='${id}'::uuid;`),"1");
eq("review audit",scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='ai.action_approved' AND entity_id='${id}'::uuid;`),"1");
for(const legacy of ["public.ai_quote_order(uuid,uuid,jsonb,public.sales_channel)","public.ai_create_digital_order(uuid,uuid,uuid,jsonb,text,text,text,text)"]){for(const role of ["anon","authenticated","service_role"]){eq(`${role} legacy lockdown ${legacy}`,scalar(`SELECT has_function_privilege('${role}','${legacy}','EXECUTE');`),"f");}}
console.log("AI action approval contract PASS: pending-only requests, payload-bound idempotency, manager review, audit, isolation and legacy mutation lockdown verified.");
