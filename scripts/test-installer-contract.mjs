import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const role = readFileSync('installer/nsis/role-selection.nsh', 'utf8');
const service = readFileSync('installer/nsis/service-install.nsh', 'utf8');
const data = readFileSync('installer/nsis/data-preservation.nsh', 'utf8');
const installer = readFileSync('installer/scripts/install-local-service.ps1', 'utf8');
const uninstaller = readFileSync('installer/scripts/uninstall-local-service.ps1', 'utf8');
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const stage = readFileSync('scripts/stage-windows-runtime.ps1', 'utf8');
const builder = readFileSync('electron-builder.config.json', 'utf8');

test('installer offers both roles and does not delete data by default', () => {
  assert.match(role, /Server \+ terminal/);
  assert.match(role, /Terminal only/);
  assert.match(data, /Preserve ZAIPOS business data/);
  assert.match(uninstaller, /ZAIPOS business data is preserved by default/);
  assert.match(uninstaller, /if \(\$PreserveData\) \{ return \}/);
  assert.doesNotMatch(uninstaller, /Remove-Item\s+[^\n]*-Recurse[^\n]*ProgramData\\ZAIPOS/);
  assert.match(service, /sc\.exe create ZAIPOSLocalService/);
  assert.match(installer, /sc\.exe create ZAIPOSLocalService/);
  assert.match(installer, /WINDOWS_DATA_ROOT_UNSAFE/);
});

test('windows package bundles the local service and PostgreSQL 17 binaries', () => {
  assert.match(workflow, /scripts\/stage-windows-runtime\.ps1/);
  assert.match(workflow, /win-unpacked\\resources\\runtime\\zaipos-local-service\.exe/);
  assert.match(workflow, /postgres\\bin\\initdb\.exe/);
  assert.match(stage, /85829f743e2697c55f1a5e8b210c53b90dd1f578448fc01cb9c4dc9e0a8e3827/);
  assert.match(stage, /postgresql-17\.11\.0-x86_64-pc-windows-msvc\.zip/);
  assert.match(stage, /zaipos-local-service\.exe/);
  assert.match(builder, /\.runtime-stage/);
  assert.match(readFileSync('installer/nsis/zaipos-local-runtime.nsh', 'utf8'), /resources\\runtime\\zaipos-local-service\.exe/);
});
