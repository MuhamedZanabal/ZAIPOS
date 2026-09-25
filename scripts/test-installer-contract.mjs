import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const role = readFileSync('installer/nsis/role-selection.nsh', 'utf8');
const service = readFileSync('installer/nsis/service-install.nsh', 'utf8');
const data = readFileSync('installer/nsis/data-preservation.nsh', 'utf8');
const installer = readFileSync('installer/scripts/install-local-service.ps1', 'utf8');
const uninstaller = readFileSync('installer/scripts/uninstall-local-service.ps1', 'utf8');

test('installer offers both roles and does not delete data by default', () => {
  assert.match(role, /Server \+ terminal/);
  assert.match(role, /Terminal only/);
  assert.match(data, /Preserve ZAIPOS business data/);
  assert.match(uninstaller, /Preserve ZAIPOS business data/);
  assert.doesNotMatch(uninstaller, /Remove-Item\s+[^\n]*-Recurse[^\n]*ProgramData\\ZAIPOS/);
  assert.match(service, /sc\.exe create ZAIPOSLocalService/);
  assert.match(installer, /sc\.exe create ZAIPOSLocalService/);
  assert.match(installer, /WINDOWS_DATA_ROOT_UNSAFE/);
});
