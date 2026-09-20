import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../supabase/functions/activate-device/index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /admin\.rpc\("has_branch_role"/,
  'activation Edge Function must use the canonical branch-role authority function',
);
assert.match(source, /_user_id:\s*userData\.user\.id/, 'role check must bind the authenticated caller');
assert.match(source, /_tenant_id:\s*approval\.tenant_id/, 'role check must bind the approved tenant');
assert.match(source, /_branch_id:\s*approval\.branch_id/, 'role check must bind the approved branch');
assert.doesNotMatch(
  source,
  /\.from\("user_roles"\)[\s\S]*?\.eq\("branch_id",\s*approval\.branch_id\)/,
  'an exact branch-row query incorrectly rejects tenant-wide owner/admin roles',
);

console.log('Device activation Edge authority contract: PASS');
