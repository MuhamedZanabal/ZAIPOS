import test from 'node:test';
import assert from 'node:assert/strict';
import { planWindowsLifecycle } from './windows-service-lifecycle.mjs';

test('server install stays on loopback and uninstall does not imply data deletion', () => {
  const installed = planWindowsLifecycle({ role: 'server+terminal', action: 'install', dataRoot: 'C:\\ProgramData\\ZAIPOS\\', preserveData: true });
  assert.equal(installed.installPostgres, true);
  assert.equal(installed.listen, '127.0.0.1');
  assert.equal(installed.deleteDataOnUninstall, false);
  const removed = planWindowsLifecycle({ role: 'terminal', action: 'uninstall', dataRoot: 'C:\\ProgramData\\ZAIPOS', preserveData: false });
  assert.equal(removed.deleteDataOnUninstall, true);
  assert.throws(() => planWindowsLifecycle({ role: 'server+terminal', action: 'upgrade', dataRoot: 'C:\\Users\\Public\\ZAIPOS', preserveData: true }), /UNSAFE/);
});
