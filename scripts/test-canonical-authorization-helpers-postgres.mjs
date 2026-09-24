import assert from 'node:assert/strict';
import { connection, literal, query } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable contract database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = statement => query(conn, statement);

const I = {
  tenantA:'aa000000-0000-4000-8000-000000000089',
  tenantB:'ab000000-0000-4000-8000-000000000089',
  branchA:'ba000000-0000-4000-8000-000000000089',
  branchB:'bb000000-0000-4000-8000-000000000089',
  active:'ca000000-0000-4000-8000-000000000089',
  scoped:'cb000000-0000-4000-8000-000000000089',
  cashier:'cc000000-0000-4000-8000-000000000089',
  banned:'cd000000-0000-4000-8000-000000000089',
  deleted:'ce000000-0000-4000-8000-000000000089',
};

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.active}','auth-active@zaipos.test','{}'),
    ('${I.scoped}','auth-scoped@zaipos.test','{}'),
    ('${I.cashier}','auth-cashier@zaipos.test','{}'),
    ('${I.banned}','auth-banned@zaipos.test','{}'),
    ('${I.deleted}','auth-deleted@zaipos.test','{}');
  UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id='${I.banned}';
  UPDATE auth.users SET deleted_at=now() WHERE id='${I.deleted}';

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock) VALUES
    ('${I.tenantA}','Auth A','auth-a-89','BHD',10,false,false),
    ('${I.tenantB}','Auth B','auth-b-89','BHD',10,false,false);
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','A','active'),
    ('${I.branchB}','${I.tenantA}','B','active');
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.active}','${I.tenantA}',NULL,'manager'),
    ('${I.scoped}','${I.tenantA}','${I.branchA}','manager'),
    ('${I.cashier}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.banned}','${I.tenantA}',NULL,'manager'),
    ('${I.deleted}','${I.tenantA}',NULL,'manager');
`);

const bool = statement => sql(`SELECT CASE WHEN (${statement}) THEN 't' ELSE 'f' END`) === 't';

assert.equal(bool(`public.has_branch_role('${I.active}','${I.tenantA}','${I.branchA}',ARRAY['manager']::public.app_role[])`), true, 'tenant-wide active manager must be authorized');
assert.equal(bool(`public.has_branch_role('${I.scoped}','${I.tenantA}','${I.branchA}',ARRAY['manager']::public.app_role[])`), true, 'branch-scoped active manager must be authorized in its branch');
assert.equal(bool(`public.has_branch_role('${I.scoped}','${I.tenantA}','${I.branchB}',ARRAY['manager']::public.app_role[])`), false, 'wrong branch must be denied');
assert.equal(bool(`public.has_branch_role('${I.active}','${I.tenantB}','${I.branchA}',ARRAY['manager']::public.app_role[])`), false, 'wrong tenant must be denied');
assert.equal(bool(`public.has_branch_role('${I.cashier}','${I.tenantA}','${I.branchA}',ARRAY['manager']::public.app_role[])`), false, 'unauthorized role must be denied');
assert.equal(bool(`public.has_branch_role(NULL,'${I.tenantA}','${I.branchA}',ARRAY['manager']::public.app_role[])`), false, 'missing authentication identity must be denied');
assert.equal(bool(`public.has_branch_role('${I.banned}','${I.tenantA}','${I.branchA}',ARRAY['manager']::public.app_role[])`), false, 'banned account must be denied');
assert.equal(bool(`public.has_branch_role('${I.deleted}','${I.tenantA}','${I.branchA}',ARRAY['manager']::public.app_role[])`), false, 'deleted account must be denied');

for (const helper of [
  `public.has_role('${I.banned}','${I.tenantA}','manager'::public.app_role)`,
  `public.has_any_role('${I.banned}','${I.tenantA}',ARRAY['manager']::public.app_role[])`,
  `public.is_tenant_member('${I.banned}','${I.tenantA}')`,
]) assert.equal(bool(helper), false, 'inactive accounts must fail every canonical authority helper');

assert.equal(sql(`SELECT has_function_privilege('authenticated','public.is_active_auth_user(uuid)','EXECUTE')`), 'f', 'raw account-state oracle must not be renderer-callable');
assert.equal(sql(`SELECT has_function_privilege('service_role','public.is_active_auth_user(uuid)','EXECUTE')`), 't', 'trusted service boundary must be able to verify account state');

console.log('PASS canonical authorization helpers: positive authority succeeds; missing auth, wrong tenant, wrong branch, wrong role, banned/deleted accounts are denied.');
