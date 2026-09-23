import { describe, expect, it } from 'vitest';
import { createOfflineMutationEnvelope } from '../../../electron/services/device-offline-mutation';

describe('offline mutation identity contract', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const branchId = '22222222-2222-4222-8222-222222222222';
  const leaseId = '33333333-3333-4333-8333-333333333333';
  const mutationId = '44444444-4444-4444-8444-444444444444';
  const now = new Date('2026-09-21T12:00:00.000Z');

  it('binds a stable mutation id to lease, tenant, branch and physical terminal without capability material', () => {
    const envelope = createOfflineMutationEnvelope({
      lease: { leaseId, expiresAt: '2026-09-21T12:10:00.000Z' },
      tenantId,
      branchId,
      deviceUid: 'terminal-1',
      kind: 'checkout.sale',
      payload: { totalFils: 12345, currency: 'BHD' },
      now,
      mutationId,
    });

    expect(envelope).toEqual({
      mutationId,
      leaseId,
      tenantId,
      branchId,
      deviceUid: 'terminal-1',
      kind: 'checkout.sale',
      createdAt: now.toISOString(),
      payload: { totalFils: 12345, currency: 'BHD' },
    });
    expect(JSON.stringify(envelope)).not.toContain('token');
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.payload)).toBe(true);
  });

  it('preserves caller-supplied mutation identity for deterministic lost-response replay', () => {
    const input = {
      lease: { leaseId, expiresAt: '2026-09-21T12:10:00.000Z' },
      tenantId,
      branchId,
      deviceUid: 'terminal-1',
      kind: 'checkout.sale',
      payload: { totalFils: 1000 },
      now,
      mutationId,
    } as const;
    expect(createOfflineMutationEnvelope(input).mutationId).toBe(mutationId);
    expect(createOfflineMutationEnvelope(input).mutationId).toBe(mutationId);
  });

  it('fails closed for expired authority or malformed scope identity', () => {
    expect(() => createOfflineMutationEnvelope({ lease: { leaseId, expiresAt: '2026-09-21T11:59:59.000Z' }, tenantId, branchId, deviceUid: 'terminal-1', kind: 'checkout.sale', payload: {}, now, mutationId })).toThrow(/expired/);
    expect(() => createOfflineMutationEnvelope({ lease: { leaseId, expiresAt: '2026-09-21T12:10:00.000Z' }, tenantId, branchId: 'wrong', deviceUid: 'terminal-1', kind: 'checkout.sale', payload: {}, now, mutationId })).toThrow(/branch/);
    expect(() => createOfflineMutationEnvelope({ lease: { leaseId, expiresAt: '2026-09-21T12:10:00.000Z' }, tenantId, branchId, deviceUid: '', kind: 'checkout.sale', payload: {}, now, mutationId })).toThrow(/device/);
  });
});
