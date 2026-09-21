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

import { createDeviceOfflineQueue } from '../../../electron/services/device-offline-queue';
import { createDeviceOfflineOrchestrator } from '../../../electron/services/device-offline-orchestrator';

describe('native durable offline mutation queue', () => {
  const values = new Map<string, unknown>();
  const store = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value), delete: (key: string) => values.delete(key) };
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const branchId = '22222222-2222-4222-8222-222222222222';
  const leaseId = '33333333-3333-4333-8333-333333333333';
  const mutationId = '44444444-4444-4444-8444-444444444444';
  const saleId = '55555555-5555-4555-8555-555555555555';
  const token = 'a'.repeat(64);
  const authorization = { accessToken: 'operator-token', tenantId, branchId };
  const authority = { readActive: vi.fn(() => ({ leaseId, token, issuedAt: '2026-09-21T12:00:00.000Z', expiresAt: '2026-09-21T12:10:00.000Z' })) };
  const input = { authorization, kind: 'checkout.sale' as const, mutationId, now: new Date('2026-09-21T12:01:00.000Z'), payload: { _items: [], _payments: [], _cash_session_id: null } };

  beforeEach(() => { values.clear(); mocks.encryptionAvailable = true; vi.restoreAllMocks(); authority.readActive.mockClear(); values.set('enrollment', { deviceUid: 'terminal-1' }); });

  it('persists an encrypted immutable envelope without the lease token and replays the same mutation id', () => {
    const queue = createDeviceOfflineQueue(store, authority, 'https://project.supabase.co', 'publishable-key');
    expect(queue.enqueue(input)).toBe(mutationId);
    expect(queue.enqueue({ ...input, now: new Date('2026-09-21T12:02:00.000Z') })).toBe(mutationId);
    expect(queue.pending()).toEqual([{ mutationId, createdAt: '2026-09-21T12:01:00.000Z' }]);
    const persisted = JSON.stringify(values.get('offline-mutation-queue-v1'));
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain('_payments');
    expect(values.has('offline-mutation-queue-journal-v1')).toBe(false);
  });

  it('recovers the complete journal after interruption and rejects mutation payload substitution', () => {
    const queue = createDeviceOfflineQueue(store, authority, 'https://project.supabase.co', 'publishable-key');
    queue.enqueue(input);
    const state = values.get('offline-mutation-queue-v1');
    values.delete('offline-mutation-queue-v1'); values.set('offline-mutation-queue-journal-v1', state);
    expect(queue.recover().records).toHaveLength(1);
    expect(values.has('offline-mutation-queue-journal-v1')).toBe(false);
    expect(() => queue.enqueue({ ...input, payload: { _items: [{ quantity: '2.000' }], _payments: [] } })).toThrow(/different payload/);
  });

  it.each([
    ['before the primary state write', 'offline-mutation-queue-v1', 'set'],
    ['before the journal clear', 'offline-mutation-queue-journal-v1', 'delete'],
  ] as const)('recovers an enqueue interrupted %s', (_label, failureKey, failureOperation) => {
    let failOnce = true;
    const interruptedStore = {
      get: store.get,
      set: (key: string, value: unknown) => {
        if (failOnce && failureOperation === 'set' && key === failureKey) { failOnce = false; throw new Error('simulated power loss'); }
        values.set(key, value);
      },
      delete: (key: string) => {
        if (failOnce && failureOperation === 'delete' && key === failureKey) { failOnce = false; throw new Error('simulated power loss'); }
        values.delete(key);
      },
    };
    const interruptedQueue = createDeviceOfflineQueue(interruptedStore, authority, 'https://project.supabase.co', 'publishable-key');
    expect(() => interruptedQueue.enqueue(input)).toThrow(/simulated power loss/);
    expect(values.has('offline-mutation-queue-journal-v1')).toBe(true);

    const recoveredQueue = createDeviceOfflineQueue(store, authority, 'https://project.supabase.co', 'publishable-key');
    expect(recoveredQueue.pending()).toEqual([{ mutationId, createdAt: '2026-09-21T12:01:00.000Z' }]);
    expect(values.has('offline-mutation-queue-journal-v1')).toBe(false);
  });

  it('canonicalizes reordered JSON and rejects non-JSON or oversized payloads before persistence', () => {
    const queue = createDeviceOfflineQueue(store, authority, 'https://project.supabase.co', 'publishable-key');
    queue.enqueue({ ...input, payload: { _payments: [], nested: { b: 2, a: 1 }, _items: [] } });
    expect(queue.enqueue({ ...input, now: new Date('2026-09-21T12:02:00.000Z'), payload: { _items: [], nested: { a: 1, b: 2 }, _payments: [] } })).toBe(mutationId);
    expect(() => queue.enqueue({ ...input, mutationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', payload: { invalid: undefined } })).toThrow(/canonical JSON/);
    expect(() => queue.enqueue({ ...input, mutationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', payload: { huge: 'x'.repeat(1024 * 1024) } })).toThrow(/queue limit/);
    expect(queue.pending()).toHaveLength(1);
  });

  it('quarantines corrupt journal and queue state instead of blocking startup recovery', () => {
    const queue = createDeviceOfflineQueue(store, authority, 'https://project.supabase.co', 'publishable-key');
    values.set('offline-mutation-queue-v1', 'corrupt-primary');
    values.set('offline-mutation-queue-journal-v1', { version: 2, records: [] });
    expect(queue.recover()).toEqual({ version: 1, records: [] });
    expect(values.has('offline-mutation-queue-v1')).toBe(false);
    expect(values.has('offline-mutation-queue-journal-v1')).toBe(false);
    expect(queue.quarantined()).toHaveLength(2);
  });

  it('retains network failures and commits exactly the authoritative sale result', async () => {
    const queue = createDeviceOfflineQueue(store, authority, 'https://project.supabase.co', 'publishable-key'); queue.enqueue(input);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network unavailable'); }));
    await expect(queue.reconcileNext(authorization)).resolves.toMatchObject({ status: 'retained', mutationId });
    expect(queue.pending()).toHaveLength(1);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(saleId), { status: 200 })); vi.stubGlobal('fetch', fetchMock);
    await expect(queue.reconcileNext(authorization)).resolves.toEqual({ status: 'committed', mutationId, saleId });
    expect(queue.pending()).toHaveLength(0);
    const request = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    const body = JSON.parse(String(request[1].body));
    expect(body).toMatchObject({ _tenant_id: tenantId, _branch_id: branchId, _lease_id: leaseId, _lease_token: token, _device_uid: 'terminal-1', _mutation_id: mutationId });
  });

  it('quarantines malformed successful responses instead of throwing or retrying them', async () => {
    const queue = createDeviceOfflineQueue(store, authority, 'https://project.supabase.co', 'publishable-key'); queue.enqueue(input);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', { status: 200 })));
    await expect(queue.reconcileNext(authorization)).resolves.toEqual({ status: 'quarantined', mutationId });
    expect(queue.pending()).toHaveLength(0);
    expect(queue.quarantined()).toEqual([expect.objectContaining({ mutationId, reason: 'server returned malformed reconciliation JSON' })]);
  });

  it('quarantines corrupt, cross-scope, expired-authority, and server-rejected records without retrying them', async () => {
    const queue = createDeviceOfflineQueue(store, authority, 'https://project.supabase.co', 'publishable-key'); queue.enqueue(input);
    const state = values.get('offline-mutation-queue-v1') as any;
    values.set('offline-mutation-queue-v1', { ...state, records: [{ ...state.records[0], digest: '0'.repeat(64) }] });
    await expect(queue.reconcileNext(authorization)).resolves.toMatchObject({ status: 'quarantined', mutationId });
    expect(queue.pending()).toHaveLength(0);

    queue.enqueue({ ...input, mutationId: '66666666-6666-4666-8666-666666666666' });
    await expect(queue.reconcileNext({ ...authorization, branchId: '77777777-7777-4777-8777-777777777777' })).resolves.toMatchObject({ status: 'quarantined' });

    queue.enqueue({ ...input, mutationId: '88888888-8888-4888-8888-888888888888' }); authority.readActive.mockImplementationOnce(() => { throw new Error('expired'); });
    await expect(queue.reconcileNext(authorization)).resolves.toMatchObject({ status: 'quarantined' });

    queue.enqueue({ ...input, mutationId: '99999999-9999-4999-8999-999999999999' }); vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    await expect(queue.reconcileNext(authorization)).resolves.toMatchObject({ status: 'quarantined' });
    expect(queue.quarantined()).toHaveLength(4);
  });

  it('quarantines a stale-lease mutation and commits replacement-lease work through the orchestrator', async () => {
    const queue = createDeviceOfflineQueue(store, authority, 'https://project.supabase.co', 'publishable-key');
    queue.enqueue(input);
    const replacementLease = { leaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', token: 'b'.repeat(64), issuedAt: '2026-09-21T12:02:00.000Z', expiresAt: '2026-09-21T12:12:00.000Z' };
    authority.readActive
      .mockImplementationOnce(() => replacementLease)
      .mockImplementationOnce(() => replacementLease)
      .mockImplementationOnce(() => replacementLease);
    const replacementMutationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    queue.enqueue({ ...input, mutationId: replacementMutationId, now: new Date('2026-09-21T12:03:00.000Z') });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(saleId), { status: 200 })));
    const orchestrator = createDeviceOfflineOrchestrator(queue, { enabled: true });

    await expect(orchestrator.drain(authorization)).resolves.toEqual({ attempted: 2, committed: 1, quarantined: 1, retained: 0, remaining: 0 });
    expect(queue.quarantined()).toEqual([expect.objectContaining({ mutationId, reason: 'offline lease identity mismatch' })]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('quarantines all queued mutations after native authority revocation without network effects', async () => {
    const queue = createDeviceOfflineQueue(store, authority, 'https://project.supabase.co', 'publishable-key');
    queue.enqueue(input);
    queue.enqueue({ ...input, mutationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    authority.readActive
      .mockImplementationOnce(() => { throw new Error('revoked'); })
      .mockImplementationOnce(() => { throw new Error('revoked'); });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const orchestrator = createDeviceOfflineOrchestrator(queue, { enabled: true });

    await expect(orchestrator.drain(authorization)).resolves.toEqual({ attempted: 2, committed: 0, quarantined: 2, retained: 0, remaining: 0 });
    expect(queue.quarantined()).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when OS encryption is unavailable', () => {
    mocks.encryptionAvailable = false;
    const queue = createDeviceOfflineQueue(store, authority, 'https://project.supabase.co', 'publishable-key');
    expect(() => queue.enqueue(input)).toThrow(/encryption is unavailable/);
  });
});
