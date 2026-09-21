import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) => value.toString().replace(/^protected:/, '')),
}));

vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: vi.fn((value: string) => Buffer.from(`protected:${value}`)),
  decryptString: mocks.decryptString,
} }));

import { createDeviceCredentialService } from '../../../electron/services/device-credentials';

describe('authoritative device revocation custody', () => {
  const values = new Map<string, unknown>();
  const store = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) };
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const branchId = '22222222-2222-4222-8222-222222222222';
  const deviceId = '33333333-3333-4333-8333-333333333333';
  const authorization = { accessToken: 'manager-token', tenantId, branchId };
  const credential = 'a'.repeat(64);
  const provisioned = () => ({ deviceUid: 'terminal-1', tenantId, branchId, encryptedCredential: Buffer.from(`protected:${credential}`).toString('base64') });

  beforeEach(() => { values.clear(); vi.restoreAllMocks(); values.set('enrollment', provisioned()); });

  it('erases encrypted scope only after authoritative revocation succeeds and preserves stable UID', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(true), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');

    await expect(service.revoke(deviceId, authorization)).resolves.toEqual({ deviceUid: 'terminal-1', provisioned: false, revoked: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/rest/v1/rpc/revoke_device_enrollment');
    const request = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1];
    expect(request.headers).toMatchObject({ authorization: 'Bearer manager-token' });
    expect(JSON.parse(String(request.body))).toEqual({ _tenant_id: tenantId, _device_id: deviceId, _reason: 'manager_console_revocation' });
    expect(values.get('enrollment')).toEqual({ deviceUid: 'terminal-1' });
    expect(JSON.stringify(values.get('enrollment'))).not.toContain(credential);
    expect(service.identity()).toEqual({ deviceUid: 'terminal-1', provisioned: false });
    await expect(service.checkout({ _tenant_id: tenantId, _branch_id: branchId }, authorization)).rejects.toThrow(/not provisioned/);
    await expect(service.rotate('approval', authorization)).rejects.toThrow(/not provisioned/);
  });

  it('also erases stale local custody when server confirms the terminal was already revoked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(false), { status: 200 })));
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    await expect(service.revoke(deviceId, authorization)).resolves.toEqual({ deviceUid: 'terminal-1', provisioned: false, revoked: false });
    expect(values.get('enrollment')).toEqual({ deviceUid: 'terminal-1' });
  });

  it('preserves local custody when authoritative revocation fails or returns malformed evidence', async () => {
    const original = provisioned();
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'denied' }), { status: 403 })));
    await expect(service.revoke(deviceId, authorization)).rejects.toThrow(/failed/);
    expect(values.get('enrollment')).toEqual(original);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 })));
    await expect(service.revoke(deviceId, authorization)).rejects.toThrow(/invalid result/);
    expect(values.get('enrollment')).toEqual(original);
  });

  it('derives terminal identity from protected local custody instead of renderer input', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(true), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');

    await expect(service.revoke(deviceId, authorization)).resolves.toMatchObject({ deviceUid: 'terminal-1', provisioned: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.identity()).toEqual({ deviceUid: 'terminal-1', provisioned: false });
  });
});
