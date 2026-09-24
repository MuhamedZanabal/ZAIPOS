import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable contract database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = statement => execFileSync('psql', ['-X','-Atq','-v','ON_ERROR_STOP=1','-c',statement], { env: conn.env, encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
const tenant = 'aa000000-0000-0000-0000-000000000681';
const otherTenant = 'aa000000-0000-0000-0000-000000000682';
const branch = 'bb000000-0000-0000-0000-000000000681';
const otherBranch = 'bb000000-0000-0000-0000-000000000682';
const actors = {
  owner: 'cc000000-0000-0000-0000-000000000681',
  admin: 'cc000000-0000-0000-0000-000000000682',
  manager: 'cc000000-0000-0000-0000-000000000683',
  cashier: 'cc000000-0000-0000-0000-000000000684',
  outsider: 'cc000000-0000-0000-0000-000000000685',
  banned: 'cc000000-0000-0000-0000-000000000686',
};

sql(`
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 ('${actors.owner}','export-owner@zaipos.test','{}'),
 ('${actors.admin}','export-admin@zaipos.test','{}'),
 ('${actors.manager}','export-manager@zaipos.test','{}'),
 ('${actors.cashier}','export-cashier@zaipos.test','{}'),
 ('${actors.outsider}','export-outsider@zaipos.test','{}'),
 ('${actors.banned}','export-banned@zaipos.test','{}');
UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id='${actors.banned}';
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock) VALUES
 ('${tenant}','Export Authority','export-authority','BHD',10,false,false),
 ('${otherTenant}','Other Export Authority','other-export-authority','BHD',10,false,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES
 ('${branch}','${tenant}','Export Branch','active'),
 ('${otherBranch}','${otherTenant}','Other Export Branch','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
 ('${actors.owner}','${tenant}','${branch}','owner'),
 ('${actors.admin}','${tenant}','${branch}','admin'),
 ('${actors.manager}','${tenant}','${branch}','manager'),
 ('${actors.cashier}','${tenant}','${branch}','cashier'),
 ('${actors.outsider}','${otherTenant}','${otherBranch}','manager'),
 ('${actors.banned}','${tenant}','${branch}','manager');
`);

function invoke(actor, targetTenant=tenant, targetBranch=branch, domain='catalogue') {
  return sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${actor}'; SELECT public.export_business_data_v1('${targetTenant}','${targetBranch}','${domain}'); COMMIT;`);
}
function denied(fn, label) {
  assert.throws(fn, /Forbidden|not active|permission/i, label);
}
for (const role of ['owner','admin','manager']) {
  const result = JSON.parse(invoke(actors[role]));
  assert.equal(result.schema, 'zaipos.business-export.v1');
  assert.equal(result.tenant_id, tenant);
  assert.equal(result.branch_id, branch);
  assert.equal(result.domain, 'catalogue');
  assert.equal(result.row_count, 0);
}
denied(() => invoke(actors.cashier), 'cashier must not export business data');
denied(() => invoke(actors.outsider), 'other-tenant manager must not export this tenant/branch');
denied(() => invoke(actors.manager, tenant, otherBranch), 'tenant/branch mismatch must fail closed');
denied(() => invoke(actors.banned), 'banned manager must not export business data');
const inventory = JSON.parse(invoke(actors.manager, tenant, branch, 'inventory'));
assert.equal(inventory.row_count, 0);
assert.equal(inventory.domain, 'inventory');
assert.throws(() => invoke(actors.manager, tenant, branch, 'unsupported'), /Unsupported export domain/i);
console.log('PASS: business export authorization matrix enforces role, tenant, branch, account state and domain boundaries.');
