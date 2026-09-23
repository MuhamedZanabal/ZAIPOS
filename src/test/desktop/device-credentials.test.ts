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

  it('brokers customer credit payments through native custody and rejects scope substitution', async () => {
    values.set('enrollment', {
      deviceUid: 'terminal-1', tenantId, branchId,
      encryptedCredential: Buffer.from(`protected:${'b'.repeat(64)}`).toString('base64'),
    });
    const entryId = '55555555-5555-4555-8555-555555555555';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(entryId), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    const payload = {
      _tenant_id: tenantId, _branch_id: branchId,
      _customer_id: '66666666-6666-4666-8666-666666666666',
      _amount_fils: '1250', _payment_method: 'cash',
      _payment_reference: 'CREDIT-RECEIPT-001', _operation_id: 'credit-payment-001',
    };

    await expect(service.customerCreditPayment(payload, authorization)).resolves.toBe(entryId);
    const [url, request] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toContain('/rest/v1/rpc/record_customer_credit_payment_v2_device');
    expect(JSON.parse(String(request.body))).toEqual({
      ...payload, _device_uid: 'terminal-1', _device_credential: 'b'.repeat(64),
    });

    await expect(service.customerCreditPayment({ ...payload, _branch_id: otherBranchId }, authorization)).rejects.toThrow(/scope/i);
    await expect(service.customerCreditPayment({ ...payload, _amount_fils: '1.5' }, authorization)).rejects.toThrow(/exact fils/i);
    await expect(service.customerCreditPayment({ ...payload, _operation_id: ' short-id' }, authorization)).rejects.toThrow(/operation ID/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('brokers supplier payments through native custody and rejects scope substitution', async () => {
    values.set('enrollment', {
      deviceUid: 'terminal-1', tenantId, branchId,
      encryptedCredential: Buffer.from(`protected:${'b'.repeat(64)}`).toString('base64'),
    });
    const entryId = '55555555-5555-4555-8555-555555555555';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(entryId), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    const payload = {
      _tenant_id: tenantId, _branch_id: branchId,
      _supplier_id: '66666666-6666-4666-8666-666666666666',
      _amount_fils: '800', _payment_method: 'bank_transfer',
      _payment_reference: 'BANK-REF-111', _note: 'Part payment',
      _operation_id: 'supplier-payment-001',
    };

    await expect(service.supplierPayment(payload, authorization)).resolves.toBe(entryId);
    const [url, request] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toContain('/rest/v1/rpc/record_supplier_payment_v2_device');
    expect(JSON.parse(String(request.body))).toEqual({
      ...payload, _device_uid: 'terminal-1', _device_credential: 'b'.repeat(64),
    });

    await expect(service.supplierPayment({ ...payload, _branch_id: otherBranchId }, authorization)).rejects.toThrow(/scope/i);
    await expect(service.supplierPayment({ ...payload, _amount_fils: '1.5' }, authorization)).rejects.toThrow(/exact fils/i);
    await expect(service.supplierPayment({ ...payload, _operation_id: ' short-id' }, authorization)).rejects.toThrow(/operation ID/i);
    await expect(service.supplierPayment({ ...payload, _payment_method: 'crypto' as 'cash' }, authorization)).rejects.toThrow(/payment method/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('brokers delivery collection through native custody and rejects scope substitution', async () => {
    values.set('enrollment', {
      deviceUid: 'terminal-1', tenantId, branchId,
      encryptedCredential: Buffer.from(`protected:${'b'.repeat(64)}`).toString('base64'),
    });
    const collectionId = '77777777-7777-4777-8777-777777777777';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(collectionId), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    const payload = {
      _tenant_id: tenantId, _branch_id: branchId,
      _order_id: '55555555-5555-4555-8555-555555555555',
      _method: 'cash' as const,
      _session_id: '66666666-6666-4666-8666-666666666666',
      _client_mutation_id: 'delivery-collect:55555555-5555-4555-8555-555555555555',
      _reference: null,
    };

    await expect(service.collectDeliveryPayment(payload, authorization)).resolves.toBe(collectionId);
    const [url, request] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toContain('/rest/v1/rpc/collect_delivery_payment_v3_device');
    expect(JSON.parse(String(request.body))).toEqual({
      ...payload, _device_uid: 'terminal-1', _device_credential: 'b'.repeat(64),
    });

    await expect(service.collectDeliveryPayment({ ...payload, _branch_id: otherBranchId }, authorization)).rejects.toThrow(/scope/i);
    await expect(service.collectDeliveryPayment({ ...payload, _method: 'cheque' as 'cash' }, authorization)).rejects.toThrow(/method/i);
    await expect(service.collectDeliveryPayment({ ...payload, _client_mutation_id: ' padded-id' }, authorization)).rejects.toThrow(/operation ID/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('brokers table checkout through native custody and validates exact money before decrypting', async () => {
    values.set('enrollment', {
      deviceUid: 'terminal-1', tenantId, branchId,
      encryptedCredential: Buffer.from(`protected:${'b'.repeat(64)}`).toString('base64'),
    });
    const saleId = '77777777-7777-4777-8777-777777777777';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(saleId), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    const payload = {
      _tenant_id: tenantId, _branch_id: branchId,
      _order_id: '55555555-5555-4555-8555-555555555555',
      _payments: [{ method: 'cash' as const, amount: '1.250', reference: null }],
      _tip_amount: '0.250', _discount_total: '0.000', _coupon_code: null,
      _client_mutation_id: 'table-checkout:55555555-5555-4555-8555-555555555555',
    };

    await expect(service.checkoutTableOrder(payload, authorization)).resolves.toBe(saleId);
    const [url, request] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toContain('/rest/v1/rpc/checkout_table_order_v2_device');
    expect(JSON.parse(String(request.body))).toEqual({
      ...payload, _device_uid: 'terminal-1', _device_credential: 'b'.repeat(64),
    });

    await expect(service.checkoutTableOrder({ ...payload, _branch_id: otherBranchId }, authorization)).rejects.toThrow(/scope/i);
    await expect(service.checkoutTableOrder({ ...payload, _tip_amount: '0.0001' }, authorization)).rejects.toThrow(/tip/i);
    await expect(service.checkoutTableOrder({ ...payload, _payments: [{ method: 'cash', amount: '1.5x', reference: null }] }, authorization)).rejects.toThrow(/payment/i);
    await expect(service.checkoutTableOrder({ ...payload, _client_mutation_id: ' padded-id' }, authorization)).rejects.toThrow(/operation ID/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('brokers returns and voids through native custody without exposing the credential', async () => {
    values.set('enrollment', {
      deviceUid: 'terminal-1', tenantId, branchId,
      encryptedCredential: Buffer.from(`protected:${'b'.repeat(64)}`).toString('base64'),
    });
    const returnId = '77777777-7777-4777-8777-777777777777';
    const voidId = '88888888-8888-4888-8888-888888888888';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(returnId), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(voidId), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    const returnPayload = {
      _tenant_id: tenantId, _branch_id: branchId,
      _sale_id: '55555555-5555-4555-8555-555555555555',
      _items: [{ sale_item_id: '66666666-6666-4666-8666-666666666666', quantity: 1 }],
      _reason_code: 'customer_request', _client_mutation_id: 'return-operation-001',
      _cash_session_id: '99999999-9999-4999-8999-999999999999',
      _reason: null, _evidence_url: null,
    };
    const voidPayload = {
      _tenant_id: tenantId, _branch_id: branchId,
      _sale_id: '55555555-5555-4555-8555-555555555555',
      _client_mutation_id: 'void-operation-001',
      _cash_session_id: '99999999-9999-4999-8999-999999999999',
      _reason: 'Duplicate transaction',
    };

    await expect(service.returnSale(returnPayload, authorization)).resolves.toBe(returnId);
    await expect(service.voidSale(voidPayload, authorization)).resolves.toBe(voidId);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toContain('/rest/v1/rpc/process_sale_return_v3_device');
    expect(calls[1][0]).toContain('/rest/v1/rpc/process_sale_void_v3_device');
    expect(JSON.parse(String(calls[0][1].body))).toMatchObject({
      ...returnPayload, _device_uid: 'terminal-1', _device_credential: 'b'.repeat(64),
    });
    expect(JSON.parse(String(calls[1][1].body))).toMatchObject({
      ...voidPayload, _device_uid: 'terminal-1', _device_credential: 'b'.repeat(64),
    });
    expect(JSON.stringify(await Promise.all(calls.map(async ([, request]) => request.body)))).not.toContain('protected:');
  });

  it('rejects return and void scope substitution before decrypting or requesting', async () => {
    values.set('enrollment', {
      deviceUid: 'terminal-1', tenantId, branchId,
      encryptedCredential: Buffer.from(`protected:${'b'.repeat(64)}`).toString('base64'),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = createDeviceCredentialService(store, 'https://project.supabase.co', 'publishable-key');
    const common = {
      _tenant_id: tenantId, _branch_id: otherBranchId,
      _sale_id: '55555555-5555-4555-8555-555555555555',
      _client_mutation_id: 'operation-001',
      _cash_session_id: '99999999-9999-4999-8999-999999999999',
      _reason: 'Verified reason',
    };

    await expect(service.returnSale({ ...common, _items: [{ sale_item_id: '66666666-6666-4666-8666-666666666666', quantity: 1 }], _reason_code: 'customer_request', _evidence_url: null }, authorization)).rejects.toThrow(/scope/i);
    await expect(service.voidSale(common, authorization)).rejects.toThrow(/scope/i);
    expect(mocks.decryptString).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
    await expect(service.supplierPayment({
      _tenant_id: tenantId, _branch_id: branchId,
      _supplier_id: '66666666-6666-4666-8666-666666666666',
      _amount_fils: '800', _payment_method: 'bank_transfer',
      _payment_reference: 'BANK-REF-111', _note: null,
      _operation_id: 'supplier-payment-unprovisioned',
    }, authorization)).rejects.toThrow(/not provisioned/);
  });
});
