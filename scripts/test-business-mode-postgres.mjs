import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable contract database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = statement => execFileSync('psql',['-X','-Atq','-v','ON_ERROR_STOP=1','-c',statement],{env:conn.env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const execFileAsync = promisify(execFile);
const bootstrapUserA='cc000000-0000-0000-0000-000000000901';
const bootstrapUserB='cc000000-0000-0000-0000-000000000902';
const retail='aa000000-0000-0000-0000-000000000901';
const restaurant='aa000000-0000-0000-0000-000000000902';
const retailBranch='bb000000-0000-0000-0000-000000000901';
const restaurantBranch='bb000000-0000-0000-0000-000000000902';

// The migration-chain harness may leave supported-upgrade fixtures behind.
// This contract owns the disposable database from this point forward.
sql('TRUNCATE public.tenants CASCADE');
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 ('${bootstrapUserA}','mode-bootstrap-a@zaipos.test','{}'),
 ('${bootstrapUserB}','mode-bootstrap-b@zaipos.test','{}');`);
const bootstrap = (user, name, mode) => execFileAsync('psql',[
  '-X','-Atq','-v','ON_ERROR_STOP=1','-c',
  `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${user}'; SELECT * FROM public.bootstrap_tenant_v2('${name}','Main',10,'${mode}'); COMMIT;`,
],{env:conn.env,encoding:'utf8'});
const concurrentBootstrap = await Promise.allSettled([
  bootstrap(bootstrapUserA,'Concurrent Retail','RETAIL'),
  bootstrap(bootstrapUserB,'Concurrent Restaurant','RESTAURANT'),
]);
assert.equal(concurrentBootstrap.filter(result => result.status === 'fulfilled').length,1,'exactly one concurrent bootstrap must commit');
assert.equal(concurrentBootstrap.filter(result => result.status === 'rejected').length,1,'the competing bootstrap must fail closed');
assert.equal(sql('SELECT count(*) FROM public.tenants'),'1');
sql(`TRUNCATE public.tenants CASCADE; DELETE FROM auth.users WHERE id IN ('${bootstrapUserA}','${bootstrapUserB}');`);

sql(`INSERT INTO public.tenants(id,name,slug,business_mode) VALUES
 ('${retail}','Retail Mode','mode-retail','RETAIL'),('${restaurant}','Restaurant Mode','mode-restaurant','RESTAURANT');
 INSERT INTO public.branches(id,tenant_id,name) VALUES
 ('${retailBranch}','${retail}','Retail Branch'),('${restaurantBranch}','${restaurant}','Restaurant Branch');`);

assert.throws(() => sql(`INSERT INTO public.tables(tenant_id,branch_id,name) VALUES('${retail}','${retailBranch}','Forbidden Table')`), /Restaurant operations are disabled/);
assert.equal(sql(`SELECT count(*) FROM public.tables WHERE tenant_id='${retail}'`),'0');
assert.equal(sql(`SELECT 'tables'::public.sales_channel = ANY(active_channels) FROM public.tenants WHERE id='${retail}'`),'f');
sql(`INSERT INTO public.tables(tenant_id,branch_id,name) VALUES('${restaurant}','${restaurantBranch}','Allowed Table')`);
assert.equal(sql(`SELECT count(*) FROM public.tables WHERE tenant_id='${restaurant}'`),'1');
assert.throws(() => sql(`UPDATE public.tenants SET business_mode='RESTAURANT' WHERE id='${retail}'`), /immutable/i);
assert.equal(sql(`SELECT has_function_privilege('authenticated','public.bootstrap_first_tenant(text,text,numeric,text)','EXECUTE')::text`),'false');
assert.equal(sql(`SELECT has_function_privilege('anon','public.bootstrap_tenant_v2(text,text,numeric,text)','EXECUTE')::text`),'false');
assert.equal(sql(`SELECT has_function_privilege('authenticated','public.bootstrap_tenant_v2(text,text,numeric,text)','EXECUTE')::text`),'true');
console.log('PASS authoritative business mode: immutable selection, backend restaurant denial and bootstrap grants');
