import { describe, expect, it, vi } from 'vitest';

import { createDeviceOfflineOrchestrator } from '../../../electron/services/device-offline-orchestrator';

const authorization = {
  accessToken: 'operator-token',
  tenantId: '11111111-1111-4111-8111-111111111111',
  branchId: '22222222-2222-4222-8222-222222222222',
};

const capture = {
  authorization,
  kind: 'checkout.sale' as const,
  mutationId: '33333333-3333-4333-8333-333333333333',
  payload: { _items: [], _payments: [], _client_mutation_id: '33333333-3333-4333-8333-333333333333' },
};

describe('native offline checkout orchestration gate', () => {
  it('rejects capture and reconciliation while the release gate is disabled', async () => {
    const queue = {
      enqueue: vi.fn(() => capture.mutationId),
      pending: vi.fn(() => [{ mutationId: capture.mutationId, createdAt: '2026-09-21T12:00:00.000Z' }]),
      quarantined: vi.fn(() => []),
      confirmed: vi.fn(() => []),
      reconcileNext: vi.fn(async () => ({ status: 'committed' as const, mutationId: capture.mutationId })),
    };
    const orchestrator = createDeviceOfflineOrchestrator(queue, { enabled: false });

    expect(() => orchestrator.capture(capture)).toThrow(/offline checkout is disabled/i);
    await expect(orchestrator.drain(authorization)).rejects.toThrow(/offline checkout is disabled/i);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(queue.reconcileNext).not.toHaveBeenCalled();
    expect(orchestrator.recovery()).toEqual([
      { mutationId: capture.mutationId, state: 'pending', createdAt: '2026-09-21T12:00:00.000Z' },
    ]);
  });

  it('snapshots the disabled release gate so later option mutation cannot enable financial work', () => {
    const queue = {
      enqueue: vi.fn(() => capture.mutationId),
      pending: vi.fn(() => []),
      quarantined: vi.fn(() => []),
      confirmed: vi.fn(() => []),
      reconcileNext: vi.fn(),
    };
    const gate = { enabled: false };
    const orchestrator = createDeviceOfflineOrchestrator(queue, gate);

    gate.enabled = true;

    expect(() => orchestrator.capture(capture)).toThrow(/offline checkout is disabled/i);
    expect(orchestrator.enabled).toBe(false);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('acknowledges capture only after the native queue has persisted the mutation', () => {
    const queue = {
      enqueue: vi.fn(() => capture.mutationId),
      pending: vi.fn(() => [{ mutationId: capture.mutationId, createdAt: '2026-09-21T12:00:00.000Z' }]),
      quarantined: vi.fn(() => []),
      confirmed: vi.fn(() => []),
      reconcileNext: vi.fn(),
    };
    const orchestrator = createDeviceOfflineOrchestrator(queue, { enabled: true });

    expect(orchestrator.capture(capture)).toBe(capture.mutationId);
    expect(queue.enqueue).toHaveBeenCalledWith(capture);
    expect(queue.pending).toHaveBeenCalled();
  });

  it('refuses to acknowledge capture when persistence cannot be observed', () => {
    const queue = {
      enqueue: vi.fn(() => capture.mutationId),
      pending: vi.fn(() => []),
      quarantined: vi.fn(() => []),
      confirmed: vi.fn(() => []),
      reconcileNext: vi.fn(),
    };
    const orchestrator = createDeviceOfflineOrchestrator(queue, { enabled: true });
    expect(() => orchestrator.capture(capture)).toThrow(/was not persisted/i);
  });

  it('requires one UUID operation identity across uncertain online and offline execution', () => {
    const queue = {
      enqueue: vi.fn(() => capture.mutationId),
      pending: vi.fn(() => []),
      quarantined: vi.fn(() => []),
      confirmed: vi.fn(() => []),
      reconcileNext: vi.fn(),
    };
    const orchestrator = createDeviceOfflineOrchestrator(queue, { enabled: true });

    expect(() => orchestrator.capture({ ...capture, mutationId: undefined, payload: { _items: [], _payments: [] } }))
      .toThrow(/client mutation id/i);
    expect(() => orchestrator.capture({ ...capture, mutationId: undefined, payload: { ...capture.payload, _client_mutation_id: 'not-a-uuid' } }))
      .toThrow(/client mutation id/i);
    expect(() => orchestrator.capture({ ...capture, mutationId: '44444444-4444-4444-8444-444444444444' }))
      .toThrow(/same operation/i);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('derives the durable offline identity from the online checkout operation identity', () => {
    const queue = {
      enqueue: vi.fn(() => capture.mutationId),
      pending: vi.fn(() => [{ mutationId: capture.mutationId, createdAt: '2026-09-21T12:00:00.000Z' }]),
      quarantined: vi.fn(() => []),
      confirmed: vi.fn(() => []),
      reconcileNext: vi.fn(),
    };
    const orchestrator = createDeviceOfflineOrchestrator(queue, { enabled: true });
    const withoutExplicitMutation = { ...capture, mutationId: undefined };

    expect(orchestrator.capture(withoutExplicitMutation)).toBe(capture.mutationId);
    expect(queue.enqueue).toHaveBeenCalledWith({ ...withoutExplicitMutation, mutationId: capture.mutationId });
  });

  it('serializes concurrent drains so one queued mutation is never submitted twice locally', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let pending = [{ mutationId: capture.mutationId, createdAt: '2026-09-21T12:00:00.000Z' }];
    let reconciliations = 0;
    const queue = {
      enqueue: vi.fn(),
      pending: () => pending,
      quarantined: () => [],
      confirmed: () => [],
      reconcileNext: async () => {
        reconciliations += 1;
        await blocked;
        pending = [];
        return { status: 'committed' as const, mutationId: capture.mutationId, saleId: '44444444-4444-4444-8444-444444444444' };
      },
    };
    const orchestrator = createDeviceOfflineOrchestrator(queue, { enabled: true });

    const first = orchestrator.drain(authorization);
    const second = orchestrator.drain(authorization);
    release();

    await expect(first).resolves.toEqual({ attempted: 1, committed: 1, quarantined: 0, retained: 0, remaining: 0 });
    await expect(second).resolves.toEqual({ attempted: 1, committed: 1, quarantined: 0, retained: 0, remaining: 0 });
    expect(reconciliations).toBe(1);
  });

  it('continues past quarantine, stops on a retained network failure, and bounds work to the starting queue', async () => {
    const results = [
      { status: 'quarantined' as const, mutationId: '33333333-3333-4333-8333-333333333333' },
      { status: 'committed' as const, mutationId: '44444444-4444-4444-8444-444444444444', saleId: '55555555-5555-4555-8555-555555555555' },
      { status: 'retained' as const, mutationId: '66666666-6666-4666-8666-666666666666' },
    ];
    let remaining = 3;
    const queue = {
      enqueue: vi.fn(),
      pending: () => Array.from({ length: remaining }, (_, index) => ({ mutationId: `${index}`, createdAt: '2026-09-21T12:00:00.000Z' })),
      quarantined: () => [],
      confirmed: () => [],
      reconcileNext: async () => {
        const result = results.shift()!;
        if (result.status !== 'retained') remaining -= 1;
        return result;
      },
    };
    const orchestrator = createDeviceOfflineOrchestrator(queue, { enabled: true });

    await expect(orchestrator.drain(authorization)).resolves.toEqual({ attempted: 3, committed: 1, quarantined: 1, retained: 1, remaining: 1 });
    expect(results).toHaveLength(0);
  });

  it('exposes operator recovery states without lease capability or payload material', () => {
    const queue = {
      enqueue: vi.fn(),
      pending: () => [{ mutationId: capture.mutationId, createdAt: '2026-09-21T12:00:00.000Z' }],
      quarantined: () => [{ mutationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reason: 'revoked device', quarantinedAt: '2026-09-21T12:01:00.000Z' }],
      confirmed: () => [{ mutationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', saleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', confirmedAt: '2026-09-21T12:02:00.000Z' }],
      reconcileNext: vi.fn(),
    };
    const orchestrator = createDeviceOfflineOrchestrator(queue, { enabled: false });
    const snapshot = orchestrator.recovery();
    expect(snapshot.map((item) => item.state)).toEqual(['pending', 'revoked_device', 'confirmed']);
    expect(JSON.stringify(snapshot)).not.toMatch(/lease|token|credential|ciphertext|_payments/i);
  });
});
