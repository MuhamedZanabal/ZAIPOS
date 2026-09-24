import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../supabase/functions/create-user/index.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace(/^import\s+\{\s*createClient\s*\}\s+from\s+[^;]+;\s*/m, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function invoke({ branchId = 'branch-a', branchTenant = 'tenant-a', branchError = null, role = 'cashier', callerRole = 'owner', callerBranchId = null, callerState = 'active', callerStateError = null } = {}) {
  const calls = { callerState: 0, branchLookup: 0, profileLookup: 0, created: 0, inserted: 0 };
  let handler;
  const admin = {
    auth: { admin: {
      createUser: async () => { calls.created++; return { data: { user: { id: 'new-user' } }, error: null }; },
      getUserById: async () => {
        calls.callerState++;
        if (callerStateError) return { data: { user: null }, error: callerStateError };
        if (callerState === 'missing') return { data: { user: null }, error: null };
        if (callerState === 'banned') return { data: { user: { id: 'caller', banned_until: new Date(Date.now() + 86400000).toISOString(), deleted_at: null } }, error: null };
        if (callerState === 'deleted') return { data: { user: { id: 'caller', banned_until: null, deleted_at: new Date().toISOString() } }, error: null };
        return { data: { user: { id: 'caller', banned_until: null, deleted_at: null } }, error: null };
      },
    } },
    from(table) {
      const filters = {};
      let selected;
      const query = {
        select(value) { selected = value; return this; },
        eq(key, value) { filters[key] = value; return this; },
        ilike() { return this; },
        then(resolve, reject) {
          if (table !== 'user_roles' || selected !== 'role,branch_id') throw new Error(`Unexpected awaited query: ${table}.${selected}`);
          return Promise.resolve({ data: [{ role: callerRole, branch_id: callerBranchId }], error: null }).then(resolve, reject);
        },
        async maybeSingle() {
          if (table === 'branches') {
            calls.branchLookup++;
            assert.equal(filters.id, branchId);
            assert.equal(filters.tenant_id, 'tenant-a');
            return { data: branchError || branchTenant !== 'tenant-a' || branchId === 'missing' ? null : { id: branchId }, error: branchError };
          }
          if (table === 'profiles') { calls.profileLookup++; return { data: null, error: null }; }
          if (table === 'user_roles') return { data: null, error: null };
          throw new Error(`Unexpected lookup: ${table}`);
        },
        async insert(record) {
          assert.equal(table, 'user_roles');
          calls.inserted++;
          assert.equal(record.tenant_id, 'tenant-a');
          assert.equal(record.branch_id, branchId);
          return { error: null };
        },
      };
      return query;
    },
  };
  const user = { auth: { getUser: async () => ({ data: { user: { id: 'caller' } }, error: null }) } };
  const context = {
    createClient: (_url, key) => key === 'service-key' ? admin : user,
    Deno: { env: { get: name => ({ SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_PUBLISHABLE_KEY: 'anon-key' })[name] }, serve: fn => { handler = fn; } },
    Response,
  };
  vm.runInNewContext(compiled, context, { filename: 'create-user/index.ts' });
  assert.equal(typeof handler, 'function');
  const response = await handler(new Request('https://example.test/create-user', {
    method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'new@example.test', password: 'valid-password', role, tenant_id: 'tenant-a', branch_id: branchId }),
  }));
  return { status: response.status, body: await response.json(), calls };
}

test('create-user permits a tenant-wide owner for an existing tenant branch', async () => {
  const { status, calls } = await invoke();
  assert.equal(status, 200);
  assert.equal(calls.branchLookup, 1);
  assert.equal(calls.created, 1);
  assert.equal(calls.inserted, 1);
});

test('create-user permits a branch-scoped admin only in the same branch', async () => {
  const { status, calls } = await invoke({ callerRole: 'admin', callerBranchId: 'branch-a' });
  assert.equal(status, 200);
  assert.equal(calls.created, 1);
  assert.equal(calls.inserted, 1);
});

for (const [name, options] of [
  ['branch-scoped owner targeting another branch', { callerBranchId: 'branch-b' }],
  ['branch-scoped admin targeting another branch', { callerRole: 'admin', callerBranchId: 'branch-b' }],
  ['manager caller', { callerRole: 'manager' }],
]) {
  test(`create-user rejects ${name} before branch lookup or mutation`, async () => {
    const { status, calls } = await invoke(options);
    assert.equal(status, 403);
    assert.equal(calls.branchLookup, 0);
    assert.equal(calls.profileLookup, 0);
    assert.equal(calls.created, 0);
    assert.equal(calls.inserted, 0);
  });
}

for (const [name, options] of [
  ['foreign tenant branch', { branchTenant: 'tenant-b' }],
  ['nonexistent branch', { branchId: 'missing' }],
]) {
  test(`create-user rejects ${name} before user creation or role insertion`, async () => {
    const { status, calls } = await invoke(options);
    assert.equal(status, 403);
    assert.equal(calls.branchLookup, 1);
    assert.equal(calls.profileLookup, 0);
    assert.equal(calls.created, 0);
    assert.equal(calls.inserted, 0);
  });
}

for (const [name, options, expectedStatus] of [
  ['banned caller', { callerState: 'banned' }, 403],
  ['deleted caller', { callerState: 'deleted' }, 403],
  ['missing caller state', { callerState: 'missing' }, 403],
  ['account-state lookup failure', { callerStateError: { message: 'auth unavailable' } }, 500],
]) {
  test(`create-user rejects ${name} before role lookup or mutation`, async () => {
    const { status, calls } = await invoke(options);
    assert.equal(status, expectedStatus);
    assert.equal(calls.callerState, 1);
    assert.equal(calls.branchLookup, 0);
    assert.equal(calls.profileLookup, 0);
    assert.equal(calls.created, 0);
    assert.equal(calls.inserted, 0);
  });
}

test('create-user fails closed on branch lookup errors before any mutation', async () => {
  const { status, calls } = await invoke({ branchError: { message: 'database unavailable' } });
  assert.equal(status, 500);
  assert.equal(calls.profileLookup, 0);
  assert.equal(calls.created, 0);
  assert.equal(calls.inserted, 0);
});

