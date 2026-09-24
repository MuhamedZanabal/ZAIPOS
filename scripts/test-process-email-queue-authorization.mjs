import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../supabase/functions/process-email-queue/index.ts', import.meta.url), 'utf8');
const serviceRoleName = 'SUPABASE_' + 'SERVICE_ROLE_KEY';
const stripped = source
  .replace(/^import\s+\{\s*sendLovableEmail\s*\}\s+from\s+[^\n]+\n/m, '')
  .replace(/^import\s+\{\s*createClient\s*\}\s+from\s+[^\n]+\n/m, '');
const compiled = ts.transpileModule(stripped, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function invoke(authorization) {
  let handler;
  let createCalls = 0;
  const supabase = {
    from(table) {
      return {
        select() { return this; },
        async single() {
          assert.equal(table, 'email_send_state');
          return { data:null, error:null };
        },
      };
    },
    async rpc(name) {
      assert.equal(name, 'read_email_batch');
      return { data:[], error:null };
    },
  };
  const context = {
    sendLovableEmail: async () => { throw new Error('must not send with empty queues'); },
    createClient: () => { createCalls += 1; return supabase; },
    Deno: {
      env: { get: name => ({
        LOVABLE_API_KEY:'lovable-key',
        SUPABASE_URL:'https://example.test',
        [serviceRoleName]:'service-role-secret',
      })[name] },
      serve: fn => { handler = fn; },
    },
    Response, Request, Headers, TextEncoder, setTimeout,
    console:{ log(){}, info(){}, warn(){}, error(){} },
  };
  vm.runInNewContext(compiled, context, { filename:'process-email-queue/index.ts' });
  const headers = new Headers();
  if (authorization) headers.set('Authorization', authorization);
  const response = await handler(new Request('https://example.test/process-email-queue', { method:'POST', headers }));
  return { response, json: await response.json(), createCalls };
}

test('email worker rejects missing authentication before privileged client creation', async () => {
  const result = await invoke();
  assert.equal(result.response.status, 401);
  assert.equal(result.createCalls, 0);
});

test('email worker rejects ordinary authenticated credentials', async () => {
  const result = await invoke('Bearer user-access-token');
  assert.equal(result.response.status, 403);
  assert.equal(result.createCalls, 0);
});

test('forged JWT service_role claim is rejected unless the credential exactly matches the server secret', async () => {
  const payload = Buffer.from(JSON.stringify({ role:'service_role', sub:'attacker' })).toString('base64url');
  const forged = `x.${payload}.x`;
  const result = await invoke(`Bearer ${forged}`);
  assert.equal(result.response.status, 403);
  assert.equal(result.createCalls, 0);
});

test('exact service-role credential may enter the bounded background worker', async () => {
  const result = await invoke('Bearer service-role-secret');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.json, { processed:0 });
  assert.equal(result.createCalls, 1);
});

test('worker source does not authorize from a decoded attacker-controlled role claim', () => {
  assert.doesNotMatch(source, /parseJwtClaims/);
  assert.doesNotMatch(source, /claims\?\.role\s*!==\s*['"]service_role['"]/);
  assert.match(source, /constantTimeTextEqual\(token, supabaseServiceKey\)/);
});
