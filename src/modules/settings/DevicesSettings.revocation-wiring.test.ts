import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/modules/settings/DevicesSettings.tsx'), 'utf8');

describe('DevicesSettings revocation authority routing', () => {
  it('loads the native device identity before deciding how to revoke', () => {
    expect(source).toContain('hardware.getDeviceIdentity()');
    expect(source).toContain('setCurrentDeviceUid(identity.deviceUid)');
  });

  it('routes this physical terminal through native authoritative revoke-and-erase', () => {
    expect(source).toContain('hardware && currentDeviceUid === device.device_uid');
    expect(source).toContain('hardware.revokeDevice(device.id, await desktopAuthorization())');
  });

  it('retains server-authoritative revocation for remote terminals', () => {
    expect(source).toContain("rpc('revoke_device_enrollment'");
    expect(source).toContain("_reason: 'manager_console_revocation'");
  });

  it('never treats the local erase path as successful before native authority returns', () => {
    const nativeCall = source.indexOf('await hardware.revokeDevice');
    const localSuccess = source.indexOf('This terminal was revoked and its local credential was erased.');
    expect(nativeCall).toBeGreaterThan(-1);
    expect(localSuccess).toBeGreaterThan(nativeCall);
  });
});
