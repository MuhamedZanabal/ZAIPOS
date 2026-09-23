import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../supabase/functions/rotate-device-credential/index.ts', import.meta.url), 'utf8');

assert.match(source, /userClient\.auth\.getUser\(\)/, 'rotation must authenticate the bearer token');
assert.match(source, /approval\.approved_by\s*!==\s*userData\.user\.id/, 'rotation approval must belong to the authenticated manager');
assert.match(source, /approvedDeviceUid\s*!==\s*deviceUid/, 'rotation must bind the request to the approved device UID');
assert.match(source, /approval\.consumed_at/, 'rotation must reject consumed approvals');
assert.match(source, /Date\.parse\(approval\.expires_at\)\s*<=\s*Date\.now\(\)/, 'rotation must reject expired approvals');
assert.match(source, /admin\.rpc\("has_branch_role"/, 'rotation must revalidate canonical branch authority');
assert.match(source, /_user_id:\s*userData\.user\.id/, 'role check must bind the authenticated caller');
assert.match(source, /_tenant_id:\s*approval\.tenant_id/, 'role check must bind the approved tenant');
assert.match(source, /_branch_id:\s*approval\.branch_id/, 'role check must bind the approved branch');
assert.match(source, /admin\.rpc\("rotate_device_credential"/, 'only the privileged edge boundary may exchange an approval for a credential');
assert.match(source, /row\.device_id\s*!==\s*approval\.device_id/, 'rotation response must match the approved device');
assert.match(source, /row\.device_uid\s*!==\s*deviceUid/, 'rotation response must match the local device UID');
assert.match(source, /\^\[0-9a-f\]\{64\}\$/i, 'rotation response must contain exactly a 256-bit hexadecimal credential');
assert.doesNotMatch(source, /console\.(?:log|debug|info|warn|error)\([^)]*credential/i, 'plaintext credentials must never be logged');

console.log('Device credential rotation Edge authority contract: PASS');
