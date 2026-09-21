import { describe, expect, it } from 'vitest';

import { classifyQuarantineReason, projectOperatorRecovery } from '../../../electron/services/device-offline-recovery';

describe('native offline operator recovery projection', () => {
  const pendingId = '11111111-1111-4111-8111-111111111111';
  const replayId = '22222222-2222-4222-8222-222222222222';
  const confirmedId = '33333333-3333-4333-8333-333333333333';
  const expiredId = '44444444-4444-4444-8444-444444444444';
  const revokedId = '55555555-5555-4555-8555-555555555555';
  const corruptId = '66666666-6666-4666-8666-666666666666';
  const conflictId = '77777777-7777-4777-8777-777777777777';
  const quarantinedId = '88888888-8888-4888-8888-888888888888';

  it('classifies operator-visible recovery states without capability material', () => {
    expect(classifyQuarantineReason('expired authority')).toBe('expired_authority');
    expect(classifyQuarantineReason('offline lease identity mismatch')).toBe('expired_authority');
    expect(classifyQuarantineReason('revoked device')).toBe('revoked_device');
    expect(classifyQuarantineReason('corrupt record: integrity check failed')).toBe('corrupt_record');
    expect(classifyQuarantineReason('server returned malformed reconciliation JSON')).toBe('corrupt_record');
    expect(classifyQuarantineReason('mutation identity conflict')).toBe('conflict');
    expect(classifyQuarantineReason('authorization scope mismatch')).toBe('conflict');
    expect(classifyQuarantineReason('server rejected reconciliation (409)')).toBe('conflict');
    expect(classifyQuarantineReason('server rejected reconciliation (422)')).toBe('quarantined');
  });

  it('projects pending, replaying, confirmed, quarantine and conflict states without secrets', () => {
    const snapshot = projectOperatorRecovery({
      pending: [
        { mutationId: pendingId, createdAt: '2026-09-22T00:00:00.000Z' },
        { mutationId: replayId, createdAt: '2026-09-22T00:01:00.000Z' },
        { mutationId: conflictId, createdAt: '2026-09-22T00:02:00.000Z' },
      ],
      quarantined: [
        { mutationId: conflictId, reason: 'mutation identity conflict', quarantinedAt: '2026-09-22T00:03:00.000Z' },
        { mutationId: expiredId, reason: 'expired authority', quarantinedAt: '2026-09-22T00:04:00.000Z' },
        { mutationId: revokedId, reason: 'revoked device', quarantinedAt: '2026-09-22T00:05:00.000Z' },
        { mutationId: corruptId, reason: 'corrupt record: cannot be decrypted', quarantinedAt: '2026-09-22T00:06:00.000Z' },
        { mutationId: quarantinedId, reason: 'server rejected reconciliation (422)', quarantinedAt: '2026-09-22T00:07:00.000Z' },
      ],
      confirmed: [{ mutationId: confirmedId, saleId: '99999999-9999-4999-8999-999999999999', confirmedAt: '2026-09-22T00:08:00.000Z' }],
      replayingMutationId: replayId,
    });

    expect(snapshot).toEqual([
      { mutationId: pendingId, state: 'pending', createdAt: '2026-09-22T00:00:00.000Z' },
      { mutationId: replayId, state: 'replaying', createdAt: '2026-09-22T00:01:00.000Z' },
      { mutationId: conflictId, state: 'conflict', createdAt: '2026-09-22T00:02:00.000Z', reason: 'mutation identity conflict' },
      { mutationId: expiredId, state: 'expired_authority', createdAt: '2026-09-22T00:04:00.000Z', reason: 'expired authority' },
      { mutationId: revokedId, state: 'revoked_device', createdAt: '2026-09-22T00:05:00.000Z', reason: 'revoked device' },
      { mutationId: corruptId, state: 'corrupt_record', createdAt: '2026-09-22T00:06:00.000Z', reason: 'corrupt record: cannot be decrypted' },
      { mutationId: quarantinedId, state: 'quarantined', createdAt: '2026-09-22T00:07:00.000Z', reason: 'server rejected reconciliation (422)' },
      { mutationId: confirmedId, state: 'confirmed', createdAt: '2026-09-22T00:08:00.000Z', saleId: '99999999-9999-4999-8999-999999999999' },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/lease|token|credential|ciphertext|payload/i);
  });

  it('prefers confirmed evidence when a mutation is still queued after a crash', () => {
    const snapshot = projectOperatorRecovery({
      pending: [{ mutationId: confirmedId, createdAt: '2026-09-22T00:00:00.000Z' }],
      quarantined: [],
      confirmed: [{ mutationId: confirmedId, saleId: '99999999-9999-4999-8999-999999999999', confirmedAt: '2026-09-22T00:08:00.000Z' }],
    });
    expect(snapshot).toEqual([
      { mutationId: confirmedId, state: 'confirmed', createdAt: '2026-09-22T00:08:00.000Z', saleId: '99999999-9999-4999-8999-999999999999' },
    ]);
  });
});
