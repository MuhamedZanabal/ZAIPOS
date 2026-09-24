import assert from 'node:assert/strict';
import { connection, query } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable contract database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = statement => query(conn, statement);

const policies = JSON.parse(sql(`
  SELECT coalesce(json_agg(json_build_object(
    'name',policyname,'roles',roles,'command',cmd,'using',qual,'check',with_check
  ) ORDER BY policyname)::text,'[]')
  FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND policyname IN (
      'tenant members can upload product images',
      'tenant members can update product images',
      'tenant members can delete product images',
      'product images are publicly readable',
      'return_evidence_tenant_select',
      'return_evidence_tenant_insert'
    )
`));
const byName = new Map(policies.map(policy => [policy.name, policy]));

for (const name of [
  'tenant members can upload product images',
  'tenant members can update product images',
  'tenant members can delete product images',
]) {
  const policy = byName.get(name);
  assert.ok(policy, `missing ${name}`);
  const expression = `${policy.using ?? ''} ${policy.check ?? ''}`;
  assert.match(expression, /product-images/);
  assert.match(expression, /is_tenant_member/);
  assert.match(expression, /auth\.uid/);
}

for (const name of ['return_evidence_tenant_select','return_evidence_tenant_insert']) {
  const policy = byName.get(name);
  assert.ok(policy, `missing ${name}`);
  const expression = `${policy.using ?? ''} ${policy.check ?? ''}`;
  assert.match(expression, /return-evidence/);
  assert.match(expression, /is_tenant_member/);
  assert.match(expression, /auth\.uid/);
  assert.doesNotMatch(expression, /FROM public\.user_roles/i, 'storage policy must not bypass active-account membership helper');
}

const publicRead = byName.get('product images are publicly readable');
assert.ok(publicRead);
assert.match(String(publicRead.using), /product-images/);

console.log('PASS storage authorization: mutations are tenant-membership scoped through active-account authority; return evidence no longer bypasses the canonical helper; product-image read remains intentionally public.');
