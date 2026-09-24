import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../supabase/functions/ai-order-agent/index.ts', import.meta.url), 'utf8');
const stripped = source.replace(/^import\s+\{\s*createClient\s*\}\s+from\s+[^;]+;\s*/m, '');
const compiled = ts.transpileModule(stripped, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function invoke({ authorization = null, user = { id: 'caller' }, authError = null, method = 'POST', body = {} } = {}) {
  let handler;
  let createCalls = 0;
  let getUserCalls = 0;
  const client = {
    auth: {
      async getUser() {
        getUserCalls += 1;
        return { data: { user }, error: authError };
      },
    },
  };
  const context = {
    createClient: () => { createCalls += 1; return client; },
    Deno: {
      env: { get: name => ({ SUPABASE_URL:'https://example.test', SUPABASE_PUBLISHABLE_KEY:'anon-key' })[name] },
      serve: fn => { handler = fn; },
    },
    Response, Request,
  };
  vm.runInNewContext(compiled, context, { filename:'ai-order-agent/index.ts' });
  const headers = new Headers({ 'Content-Type':'application/json' });
  if (authorization) headers.set('authorization', authorization);
  const request = new Request('https://example.test/ai-order-agent', {
    method,
    headers,
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  const response = await handler(request);
  return { response, json: await response.json(), createCalls, getUserCalls };
}

test('AI order endpoint rejects missing authentication before client creation', async () => {
  const result = await invoke();
  assert.equal(result.response.status, 401);
  assert.equal(result.createCalls, 0);
});

test('AI order endpoint rejects invalid or inactive authentication state', async () => {
  const result = await invoke({ authorization:'Bearer invalid-user', user:null, authError:{ message:'inactive or invalid session' } });
  assert.equal(result.response.status, 401);
  assert.equal(result.createCalls, 1);
  assert.equal(result.getUserCalls, 1);
});

test('authenticated caller receives only the disabled read-only response', async () => {
  const result = await invoke({ authorization:'Bearer valid-user' });
  assert.equal(result.response.status, 200);
  assert.equal(result.json.skipped, 'p0_read_only_safety');
  assert.equal(result.json.mode, 'read_only');
  assert.equal(result.json.requires_human, true);
});

test('wrong tenant, branch, role and injected credential fields cannot create an action path', async () => {
  const result = await invoke({
    authorization:'Bearer low-privilege-user',
    body:{
      tenant_id:'foreign-tenant',
      branch_id:'foreign-branch',
      role:'super_admin',
      device_credential:'attacker-controlled',
      action:'purchase_inventory',
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.json.skipped, 'p0_read_only_safety');
  assert.equal(Object.prototype.hasOwnProperty.call(result.json, 'action_result'), false);
  const serviceRoleName = 'SUPABASE_' + 'SERVICE_ROLE_KEY';
  assert.equal(source.includes(serviceRoleName), false, 'disabled AI boundary must not hold service-role authority');
});

test('AI order endpoint rejects unsupported methods', async () => {
  const result = await invoke({ authorization:'Bearer valid-user', method:'GET' });
  assert.equal(result.response.status, 405);
  assert.equal(result.createCalls, 0);
});
