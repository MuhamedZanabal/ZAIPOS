import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('Disposable PostgreSQL database required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
function sql(statement) {
  return execFileSync('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
    env: conn.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const signatures = [
  'public.checkout_table_order(uuid,jsonb,numeric,numeric,text,text)',
];
assert.equal(
  sql(`SELECT to_regprocedure('public.checkout_table_order(uuid,jsonb)') IS NULL`),
  't',
  'The retired two-argument restaurant checkout overload must remain absent',
);
for (const signature of signatures) {
  assert.equal(sql(`SELECT to_regprocedure('${signature}') IS NOT NULL`), 't', `${signature} must be explicitly accounted for`);
  assert.equal(
    sql(`SELECT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl WHERE p.oid='${signature}'::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE')`),
    'f',
    `${signature} must not grant execute to PUBLIC`,
  );
  for (const role of ['anon', 'authenticated']) {
    assert.equal(
      sql(`SELECT has_function_privilege('${role}', '${signature}', 'EXECUTE')`),
      'f',
      `${signature} must not be callable directly by ${role}`,
    );
  }
}

const overloads = sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='checkout_table_order'`);
assert.equal(overloads, String(signatures.length), 'Every live restaurant checkout overload must be inventoried before grant closure');
assert.equal(
  sql(`SELECT to_regprocedure('public.checkout_table_order_v2_device(uuid,uuid,uuid,jsonb,numeric,numeric,text,text,text,text)') IS NOT NULL`),
  't',
  'Device-bound restaurant checkout must exist before disabling old RPCs',
);
assert.equal(
  sql(`SELECT has_function_privilege('authenticated','public.checkout_table_order_v2_device(uuid,uuid,uuid,jsonb,numeric,numeric,text,text,text,text)','EXECUTE')`),
  't',
  'Authenticated application clients may execute only the device-bound restaurant checkout entrypoint',
);
console.log('TABLE_CHECKOUT_RPC_BOUNDARY PASS: retired overload absent, live legacy overload revoked, device-only endpoint exposed.');
