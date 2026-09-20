import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  encryptionAvailable: true,
  encryptString: vi.fn((value: string) => Buffer.from(`protected:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString().replace(/^protected:/, '')),
}));

vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => mocks.encryptionAvailable,
  encryptString: mocks.encryptString,
  decryptString: mocks.decryptString,
} }));

import { createDeviceCredentialService } from '../../../electron/services/device-credentials';

describe('native device credential custody', () => {
  const values = new Map<string, unknown>();
  const store = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) };
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const branchId = '22222222-2222-4222-8222-222222222222';
  const otherTenantId = '33333333-3333-4333-8333-333333333333';
  const authorization = { accessToken: 'operator-token', tenantId, branchId };

  beforeEach(() => {
    values.clear();
    mocks.encryptionAvailable = true;
    vi.restoreAllMocks();
  });

  it('encrypts activation credential and never returns plaintext to the renderer', async () => {
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    const identity = service.identity();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_uid: identity.deviceUid, credential: 'a'.repeat(64) }), { status: 200 })));
    const result = await service.activate('approval-id', '1.0.0', 'win32', authorization);

    expect(result).toEqual({ deviceUid: identity.deviceUid, provisioned: true });
    expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(values.get('enrollment'))).not.toContain('a'.repeat(64));
    expect(mocks.encryptString).toHaveBeenCalledWith('a'.repeat(64));
  });

  it('injects decrypted credential only inside native checkout and binds tenant/branch', async () => {
    values.set('enrollment', {
      deviceUid: 'terminal-1',
      tenantId,
      branchId,
      encryptedCredential: Buffer.from(`protected:${'b'.repeat(64)}`).toString('base64'),
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify('sale-id'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    await expect(service.checkout({ _tenant_id: tenantId, _branch_id: branchId, _items: [] }, authorization)).resolves.toBe('sale-id');

    const request = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1];
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({ _device_uid: 'terminal-1', _device_credential: 'b'.repeat(64) });
    expect(request.headers).toMatchObject({ authorization: 'Bearer operator-token' });
    await expect(service.checkout({ _tenant_id: otherTenantId, _branch_id: branchId }, authorization)).rejects.toThrow(/scope/);
  });

  it('fails closed when OS encryption or provisioning is unavailable', async () => {
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    mocks.encryptionAvailable = false;
    await expect(service.activate('approval-id', '1.0.0', 'win32', authorization)).rejects.toThrow(/encryption/);
    mocks.encryptionAvailable = true;
    await expect(service.checkout({ _tenant_id: tenantId, _branch_id: branchId }, authorization)).rejects.toThrow(/not provisioned/);
  });
});
