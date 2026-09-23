import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const vault = await readFile(new URL('../electron/device-credential-vault.ts', import.meta.url), 'utf8');
const preload = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const rendererTypes = await readFile(new URL('../src/types/electron.d.ts', import.meta.url), 'utf8');
assert.match(vault, /safeStorage\.encryptString\(credential\)/, 'terminal credential must be encrypted with Electron safeStorage');
assert.match(vault, /safeStorage\.decryptString/, 'financial authority path must decrypt only in Electron main');
assert.match(vault, /OS credential protection is unavailable/, 'vault must fail closed when OS protection is unavailable');
assert.match(vault, /sameIdentity\(actual, expected\)/, 'vault must bind authority to exact tenant, branch and device identity');
assert.match(vault, /safeStorage\.encryptString\(payload\)/, 'offline lease payload must be OS encrypted at rest');
assert.match(vault, /expiresAt - issuedAt > 15 \* 60_000/, 'offline lease custody must enforce the server maximum lifetime');
assert.match(vault, /expiresAt <= Date\.now\(\)/, 'offline lease reader must reject expired authority');
assert.match(vault, /clearOfflineLease\(\)/, 'invalid or expired offline authority must be destroyed locally');
assert.match(vault, /\^\[0-9a-fA-F\]\{64\}\$/, 'vault must require 256-bit hexadecimal secrets');
for (const [name, source] of [['preload', preload], ['renderer types', rendererTypes]]) {
  assert.doesNotMatch(source, /getDeviceCredential/i, `${name} must not expose a credential getter`);
  assert.doesNotMatch(source, /readForAuthority/i, `${name} must not expose the main-process credential reader`);
  assert.doesNotMatch(source, /readOfflineLeaseForAuthority/i, `${name} must not expose the main-process lease reader`);
  assert.doesNotMatch(source, /offlineLeaseCiphertext/i, `${name} must not expose encrypted offline lease storage`);
  assert.doesNotMatch(source, /credentialCiphertext/i, `${name} must not expose encrypted credential storage`);
}
console.log('Device credential and offline lease vault contract passed');
