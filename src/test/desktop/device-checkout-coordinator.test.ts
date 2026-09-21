import { describe, expect, it, vi } from 'vitest';

import { createDeviceCheckoutCoordinator } from '../../../electron/services/device-checkout-coordinator';

const authorization = {
  accessToken: 'operator-token',
  tenantId: '11111111-1111-4111-8111-111111111111',
  branchId: '22222222-2222-4222-8222-222222222222',
};
const mutationId = '55555555-5555-4555-8555-555555555555';
const payload = { _tenant_id: authorization.tenantId, _branch_id: authorization.branchId, _client_mutation_id: mutationId, _items: [], _payments: [] };
const saleId = '33333333-3333-4333-8333-333333333333';
const lease = { leaseId: '44444444-4444-4444-8444-444444444444', token: 'a'.repeat(64), issuedAt: '2026-09-21T20:00:00.000Z', expiresAt: '2026-09-21T20:10:00.000Z' };
const drained = { attempted: 1, committed: 1, quarantined: 0, retained: 0, remaining: 0 };

function dependencies(enabled: boolean) {
  return {
    checkout: vi.fn(async () => saleId),
    readActive: vi.fn(() => lease),
    refresh: vi.fn(async () => ({ leaseId: lease.leaseId, issuedAt: lease.issuedAt, expiresAt: lease.expiresAt })),
    orchestrator: { enabled, capture: vi.fn(() => mutationId), drain: vi.fn(async () => drained) },
    report: vi.fn(),
    reportFailure: vi.fn(),
  };
}

describe('device checkout authenticated reconnect coordinator', () => {
  it('returns online checkout without touching offline authority while the release gate is disabled', async () => {
    const deps = dependencies(false);
    const coordinator = createDeviceCheckoutCoordinator(deps);

    await expect(coordinator.checkout(payload, authorization)).resolves.toBe(saleId);
    expect(deps.readActive).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.orchestrator.drain).not.toHaveBeenCalled();
    expect(deps.orchestrator.capture).not.toHaveBeenCalled();
  });

  it('drains with current native authority after a successful authenticated online checkout', async () => {
    const deps = dependencies(true);
    const coordinator = createDeviceCheckoutCoordinator(deps);

    await expect(coordinator.checkout(payload, authorization)).resolves.toBe(saleId);
    expect(deps.readActive).toHaveBeenCalledWith(authorization);
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.orchestrator.drain).toHaveBeenCalledWith(authorization);
    expect(deps.report).toHaveBeenCalledWith(drained);
  });

  it('refreshes missing or expired native authority before draining', async () => {
    const deps = dependencies(true);
    deps.readActive.mockImplementation(() => { throw new Error('expired'); });
    const coordinator = createDeviceCheckoutCoordinator(deps);

    await expect(coordinator.checkout(payload, authorization)).resolves.toBe(saleId);
    expect(deps.refresh).toHaveBeenCalledWith(authorization);
    expect(deps.orchestrator.drain).toHaveBeenCalledWith(authorization);
  });

  it('does not drain or capture when the authenticated online checkout is rejected', async () => {
    const deps = dependencies(true);
    deps.checkout.mockRejectedValueOnce(new Error('checkout rejected'));
    const coordinator = createDeviceCheckoutCoordinator(deps);

    await expect(coordinator.checkout(payload, authorization)).rejects.toThrow('checkout rejected');
    expect(deps.readActive).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.orchestrator.drain).not.toHaveBeenCalled();
    expect(deps.orchestrator.capture).not.toHaveBeenCalled();
  });

  it('preserves the committed online sale result when background authority or drain handling fails', async () => {
    const deps = dependencies(true);
    deps.readActive.mockImplementation(() => { throw new Error('expired'); });
    deps.refresh.mockRejectedValueOnce(new Error('lease service unavailable'));
    const coordinator = createDeviceCheckoutCoordinator(deps);

    await expect(coordinator.checkout(payload, authorization)).resolves.toBe(saleId);
    expect(deps.orchestrator.drain).not.toHaveBeenCalled();
    expect(deps.reportFailure).toHaveBeenCalledWith('lease service unavailable');
  });

  it('does not capture a transport failure while the release gate is disabled', async () => {
    const deps = dependencies(false);
    deps.checkout.mockRejectedValueOnce(new Error('Failed to fetch'));
    const coordinator = createDeviceCheckoutCoordinator(deps);

    await expect(coordinator.checkout(payload, authorization)).rejects.toThrow(/failed to fetch/i);
    expect(deps.orchestrator.capture).not.toHaveBeenCalled();
  });

  it('persists a native capture before acknowledging a transport failure and never treats the mutation as a sale', async () => {
    const deps = dependencies(true);
    deps.checkout.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const coordinator = createDeviceCheckoutCoordinator(deps);

    await expect(coordinator.checkout({ ...payload, _lease_token: lease.token, _device_credential: 'b'.repeat(64) }, authorization))
      .resolves.toEqual({ status: 'pending', mutationId });
    expect(deps.orchestrator.capture).toHaveBeenCalledTimes(1);
    const captured = deps.orchestrator.capture.mock.calls[0][0];
    expect(captured.mutationId).toBe(mutationId);
    expect(captured.payload).not.toHaveProperty('_lease_token');
    expect(captured.payload).not.toHaveProperty('_device_credential');
    expect(JSON.stringify(captured)).not.toContain(lease.token);
    expect(deps.orchestrator.drain).not.toHaveBeenCalled();
  });

  it('reuses the captured mutation identity for a duplicate operator retry', async () => {
    const deps = dependencies(true);
    deps.checkout.mockRejectedValue(new TypeError('Failed to fetch'));
    const coordinator = createDeviceCheckoutCoordinator(deps);

    await expect(coordinator.checkout(payload, authorization)).resolves.toEqual({ status: 'pending', mutationId });
    await expect(coordinator.checkout(payload, authorization)).resolves.toEqual({ status: 'pending', mutationId });
    expect(deps.orchestrator.capture).toHaveBeenCalledTimes(2);
    expect(deps.orchestrator.capture.mock.calls[0][0].mutationId).toBe(mutationId);
    expect(deps.orchestrator.capture.mock.calls[1][0].mutationId).toBe(mutationId);
  });
});
