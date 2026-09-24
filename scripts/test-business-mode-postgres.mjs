import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable contract database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = statement => execFileSync('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',statement],{env:conn.env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const retail='aa000000-0000-0000-0000-000000000901';
const restaurant='aa000000-0000-0000-0000-000000000902';
const retailBranch='bb000000-0000-0000-0000-000000000901';
const restaurantBranch='bb000000-0000-0000-0000-000000000902';

sql(`INSERT INTO public.tenants(id,name,slug,business_mode) VALUES
 ('${retail}','Retail Mode','mode-retail','RETAIL'),('${restaurant}','Restaurant Mode','mode-restaurant','RESTAURANT');
 INSERT INTO public.branches(id,tenant_id,name) VALUES
 ('${retailBranch}','${retail}','Retail Branch'),('${restaurantBranch}','${restaurant}','Restaurant Branch');`);

assert.throws(() => sql(`INSERT INTO public.tables(tenant_id,branch_id,name) VALUES('${retail}','${retailBranch}','Forbidden Table')`), /Restaurant operations are disabled/);
assert.equal(sql(`SELECT count(*) FROM public.tables WHERE tenant_id='${retail}'`),'0');
sql(`INSERT INTO public.tables(tenant_id,branch_id,name) VALUES('${restaurant}','${restaurantBranch}','Allowed Table')`);
assert.equal(sql(`SELECT count(*) FROM public.tables WHERE tenant_id='${restaurant}'`),'1');
assert.throws(() => sql(`UPDATE public.tenants SET business_mode='RESTAURANT' WHERE id='${retail}'`), /immutable/i);
assert.equal(sql(`SELECT has_function_privilege('authenticated','public.bootstrap_first_tenant(text,text,numeric,text)','EXECUTE')::text`),'false');
assert.equal(sql(`SELECT has_function_privilege('anon','public.bootstrap_tenant_v2(text,text,numeric,text)','EXECUTE')::text`),'false');
assert.equal(sql(`SELECT has_function_privilege('authenticated','public.bootstrap_tenant_v2(text,text,numeric,text)','EXECUTE')::text`),'true');
console.log('PASS authoritative business mode: immutable selection, backend restaurant denial and bootstrap grants');
