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
  'public.checkout_table_order(uuid,jsonb)',
  'public.checkout_table_order(uuid,jsonb,numeric,numeric,text,text)',
];
for (const signature of signatures) {
  assert.equal(sql(`SELECT to_regprocedure('${signature}') IS NOT NULL`), 't', `${signature} must be explicitly accounted for`);
  for (const role of ['PUBLIC', 'anon', 'authenticated']) {
    const privilege = role === 'PUBLIC' ? 'public' : role;
    assert.equal(
      sql(`SELECT has_function_privilege('${privilege}', '${signature}', 'EXECUTE')`),
      'f',
      `${signature} must not be callable directly by ${role}`,
    );
  }
}

const overloads = sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='checkout_table_order'`);
assert.equal(overloads, String(signatures.length), 'All restaurant checkout overloads must be inventoried before grant closure');
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
console.log('TABLE_CHECKOUT_RPC_BOUNDARY PASS: both legacy overloads revoked, device-only endpoint exposed.');
