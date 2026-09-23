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
  const otherBranchId = '44444444-4444-4444-8444-444444444444';
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
      deviceUid: 'terminal-1', tenantId, branchId,
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

  it('brokers cash movement through native custody and rejects renderer scope substitution', async () => {
    values.set('enrollment', {
      deviceUid: 'terminal-1', tenantId, branchId,
      encryptedCredential: Buffer.from(`protected:${'b'.repeat(64)}`).toString('base64'),
    });
    const movementId = '55555555-5555-4555-8555-555555555555';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(movementId), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    const payload = {
      _tenant_id: tenantId, _branch_id: branchId,
      _session_id: '66666666-6666-4666-8666-666666666666',
      _type: 'in' as const, _amount: '1.001', _reason: 'Verified float', _reference: 'FLOAT-DEVICE-001',
    };

    await expect(service.cashMovement(payload, authorization)).resolves.toBe(movementId);
    const [url, request] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toContain('/rest/v1/rpc/record_cash_movement_v3_device');
    expect(JSON.parse(String(request.body))).toMatchObject({
      ...payload, _device_uid: 'terminal-1', _device_credential: 'b'.repeat(64),
    });
    expect(request.headers).toMatchObject({ authorization: 'Bearer operator-token' });

    await expect(service.cashMovement({ ...payload, _branch_id: otherBranchId }, authorization)).rejects.toThrow(/scope/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(service.cashMovement({ ...payload, _amount: '1.0001' }, authorization)).rejects.toThrow(/exact cash amount/i);
    await expect(service.cashMovement({ ...payload, _reference: ' FLOAT-DEVICE-001' }, authorization)).rejects.toThrow(/reference/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves immutable-reference conflict codes across the native RPC boundary', async () => {
    values.set('enrollment', {
      deviceUid: 'terminal-1', tenantId, branchId,
      encryptedCredential: Buffer.from(`protected:${'b'.repeat(64)}`).toString('base64'),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'ZC001', message: 'Cash movement reference conflict' }), { status: 409 })));
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    const payload = {
      _tenant_id: tenantId, _branch_id: branchId,
      _session_id: '66666666-6666-4666-8666-666666666666',
      _type: 'in' as const, _amount: '1.001', _reason: 'Verified float', _reference: 'FLOAT-DEVICE-001',
    };
    const error = await service.cashMovement(payload, authorization).catch((cause) => cause);
    expect(error).toMatchObject({ code: 'ZC001', message: 'Cash movement reference conflict' });
  });

  it('preserves scoped custody across service restart without exposing plaintext', async () => {
    const firstService = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    const identity = firstService.identity();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_uid: identity.deviceUid, credential: 'c'.repeat(64) }), { status: 200 })));
    await firstService.activate('approval-id', '1.0.0', 'win32', authorization);

    const persisted = JSON.stringify(values.get('enrollment'));
    expect(persisted).not.toContain('c'.repeat(64));

    const fetchMock = vi.fn(async () => new Response(JSON.stringify('restart-sale-id'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const restartedService = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    expect(restartedService.identity()).toEqual({ deviceUid: identity.deviceUid, provisioned: true });
    await expect(restartedService.checkout({ _tenant_id: tenantId, _branch_id: branchId, _items: [] }, authorization)).resolves.toBe('restart-sale-id');

    const body = JSON.parse(String((fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1].body));
    expect(body).toMatchObject({ _device_uid: identity.deviceUid, _device_credential: 'c'.repeat(64) });
  });

  it('rejects stored tenant or branch substitution before decrypting or issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');

    values.set('enrollment', { deviceUid: 'terminal-1', tenantId: otherTenantId, branchId, encryptedCredential: Buffer.from(`protected:${'d'.repeat(64)}`).toString('base64') });
    await expect(service.checkout({ _tenant_id: tenantId, _branch_id: branchId }, authorization)).rejects.toThrow(/stored device credential scope/i);
    expect(mocks.decryptString).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    values.set('enrollment', { deviceUid: 'terminal-1', tenantId, branchId: otherBranchId, encryptedCredential: Buffer.from(`protected:${'e'.repeat(64)}`).toString('base64') });
    await expect(service.checkout({ _tenant_id: tenantId, _branch_id: branchId }, authorization)).rejects.toThrow(/stored device credential scope/i);
    expect(mocks.decryptString).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rotates through the authenticated edge boundary and atomically replaces only encrypted local custody', async () => {
    const oldCredential = 'e'.repeat(64);
    const newCredential = 'f'.repeat(64);
    values.set('enrollment', { deviceUid: 'terminal-1', tenantId, branchId, encryptedCredential: Buffer.from(`protected:${oldCredential}`).toString('base64') });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ device_id: 'device-id', device_uid: 'terminal-1', credential: newCredential }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');

    await expect(service.rotate('rotation-approval', authorization)).resolves.toEqual({ deviceUid: 'terminal-1', provisioned: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/functions/v1/rotate-device-credential');
    const request = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1];
    expect(JSON.parse(String(request.body))).toEqual({ approval_id: 'rotation-approval', device_uid: 'terminal-1' });
    expect(request.headers).toMatchObject({ authorization: 'Bearer operator-token' });
    const persisted = JSON.stringify(values.get('enrollment'));
    expect(persisted).not.toContain(oldCredential);
    expect(persisted).not.toContain(newCredential);
    expect(mocks.encryptString).toHaveBeenCalledWith(newCredential);
  });

  it('does not replace local custody when rotation fails or returns a mismatched device', async () => {
    const original = { deviceUid: 'terminal-1', tenantId, branchId, encryptedCredential: Buffer.from(`protected:${'a'.repeat(64)}`).toString('base64') };
    values.set('enrollment', original);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'denied' }), { status: 403 })));
    await expect(service.rotate('rotation-approval', authorization)).rejects.toThrow(/failed/);
    expect(values.get('enrollment')).toEqual(original);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_uid: 'other-terminal', credential: 'b'.repeat(64) }), { status: 200 })));
    await expect(service.rotate('rotation-approval', authorization)).rejects.toThrow(/identity mismatch/);
    expect(values.get('enrollment')).toEqual(original);
  });

  it('fails closed when OS encryption or provisioning is unavailable', async () => {
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    mocks.encryptionAvailable = false;
    await expect(service.activate('approval-id', '1.0.0', 'win32', authorization)).rejects.toThrow(/encryption/);
    mocks.encryptionAvailable = true;
    await expect(service.checkout({ _tenant_id: tenantId, _branch_id: branchId }, authorization)).rejects.toThrow(/not provisioned/);
    await expect(service.rotate('rotation-approval', authorization)).rejects.toThrow(/not provisioned/);
    await expect(service.cashMovement({
      _tenant_id: tenantId, _branch_id: branchId,
      _session_id: '66666666-6666-4666-8666-666666666666',
      _type: 'in', _amount: '1.001', _reason: 'Verified float', _reference: 'FLOAT-DEVICE-001',
    }, authorization)).rejects.toThrow(/not provisioned/);
  });
});
