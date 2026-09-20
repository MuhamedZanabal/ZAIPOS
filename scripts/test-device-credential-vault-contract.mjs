import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const vault = await readFile(new URL('../electron/device-credential-vault.ts', import.meta.url), 'utf8');
const preload = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const rendererTypes = await readFile(new URL('../src/types/electron.d.ts', import.meta.url), 'utf8');

assert.match(vault, /safeStorage\.encryptString\(credential\)/, 'terminal credential must be encrypted with Electron safeStorage');
assert.match(vault, /safeStorage\.decryptString/, 'financial authority path must decrypt only in Electron main');
assert.match(vault, /OS credential protection is unavailable/, 'vault must fail closed when OS protection is unavailable');
assert.match(vault, /actual\.tenantId !== expected\.tenantId/, 'vault must bind credential to tenant');
assert.match(vault, /actual\.branchId !== expected\.branchId/, 'vault must bind credential to branch');
assert.match(vault, /actual\.deviceUid !== expected\.deviceUid/, 'vault must bind credential to device UID');
assert.match(vault, /\^\[0-9a-fA-F\]\{64\}\$/, 'vault must require a 256-bit hexadecimal credential');

for (const [name, source] of [['preload', preload], ['renderer types', rendererTypes]]) {
  assert.doesNotMatch(source, /getDeviceCredential/i, `${name} must not expose a credential getter`);
  assert.doesNotMatch(source, /readForAuthority/i, `${name} must not expose the main-process secret reader`);
  assert.doesNotMatch(source, /credentialCiphertext/i, `${name} must not expose encrypted credential storage`);
}

console.log('Device credential vault contract passed');
