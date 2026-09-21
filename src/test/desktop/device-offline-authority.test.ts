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

import { createDeviceOfflineAuthority } from '../../../electron/services/device-offline-authority';

describe('native bounded offline authority', () => {
  const values = new Map<string, unknown>();
  const store = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value), delete: (key: string) => values.delete(key) };
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const branchId = '22222222-2222-4222-8222-222222222222';
  const authorization = { accessToken: 'operator-token', tenantId, branchId };
  const credential = 'a'.repeat(64);
  beforeEach(() => {
    values.clear(); mocks.encryptionAvailable = true; vi.restoreAllMocks();
    values.set('enrollment', { deviceUid: 'terminal-1', tenantId, branchId, encryptedCredential: Buffer.from(`protected:${credential}`).toString('base64') });
  });

  it('requests a server lease with the native credential and persists only OS-protected capability material', async () => {
    const leaseToken = 'b'.repeat(64);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ lease_id: '33333333-3333-4333-8333-333333333333', lease_token: leaseToken, expires_at: expiresAt }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const authority = createDeviceOfflineAuthority(store, 'https://project.supabase.co', 'publishable-key');
    const result = await authority.refresh(authorization);
    expect(result).toMatchObject({ leaseId: '33333333-3333-4333-8333-333333333333', expiresAt });
    expect(JSON.stringify(result)).not.toContain(leaseToken);
    const request = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(request[0]).toContain('/rest/v1/rpc/issue_device_offline_lease');
    expect(JSON.parse(String(request[1].body))).toMatchObject({ _tenant_id: tenantId, _branch_id: branchId, _device_uid: 'terminal-1', _device_credential: credential });
    const persisted = String(values.get('offline-lease'));
    expect(persisted).not.toContain(leaseToken);
    expect(mocks.encryptString).toHaveBeenCalledWith(expect.stringContaining(leaseToken));
  });

  it('fails closed and clears stale custody when issuance is denied or lifetime is invalid', async () => {
    const authority = createDeviceOfflineAuthority(store, 'https://project.supabase.co', 'publishable-key');
    values.set('offline-lease', 'stale');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    await expect(authority.refresh(authorization)).rejects.toThrow(/failed/);
    expect(values.has('offline-lease')).toBe(false);

    values.set('offline-lease', 'stale');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ lease_id: '33333333-3333-4333-8333-333333333333', lease_token: 'c'.repeat(64), expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }]), { status: 200 })));
    await expect(authority.refresh(authorization)).rejects.toThrow(/lifetime/);
    expect(values.has('offline-lease')).toBe(false);
  });

  it('rejects tenant or branch substitution before decrypting credential authority', async () => {
    const authority = createDeviceOfflineAuthority(store, 'https://project.supabase.co', 'publishable-key');
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(authority.refresh({ ...authorization, branchId: '44444444-4444-4444-8444-444444444444' })).rejects.toThrow(/scope/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
