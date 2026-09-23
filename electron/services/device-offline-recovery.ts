export type OperatorRecoveryState =
  | 'pending'
  | 'replaying'
  | 'confirmed'
  | 'quarantined'
  | 'expired_authority'
  | 'revoked_device'
  | 'corrupt_record'
  | 'conflict';

export type OperatorRecoveryRecord = Readonly<{
  mutationId: string;
  state: OperatorRecoveryState;
  createdAt: string;
  saleId?: string;
  reason?: string;
}>;

type PendingRecord = Readonly<{ mutationId: string; createdAt: string }>;
type QuarantineRecord = Readonly<{ mutationId: string; reason: string; quarantinedAt: string }>;
type ConfirmedRecord = Readonly<{ mutationId: string; saleId: string; confirmedAt: string }>;

export function classifyQuarantineReason(reason: string): OperatorRecoveryState {
  const value = reason.toLowerCase();
  if (value.includes('conflict') || value.includes('different payload') || value.includes('already used') || value.includes('scope mismatch') || /\(409\)/.test(value)) {
    return 'conflict';
  }
  if (value.includes('revok')) return 'revoked_device';
  if (
    value.includes('corrupt')
    || value.includes('integrity')
    || value.includes('decrypt')
    || value.includes('malformed')
    || value.includes('invalid sale')
    || value.includes('payload is invalid')
  ) {
    return 'corrupt_record';
  }
  if (value.includes('expir') || value.includes('lease identity') || value.includes('authority unavailable')) {
    return 'expired_authority';
  }
  return 'quarantined';
}

export function projectOperatorRecovery(input: {
  pending: ReadonlyArray<PendingRecord>;
  quarantined: ReadonlyArray<QuarantineRecord>;
  confirmed: ReadonlyArray<ConfirmedRecord>;
  replayingMutationId?: string | null;
}): readonly OperatorRecoveryRecord[] {
  const confirmedById = new Map(input.confirmed.map((entry) => [entry.mutationId, entry]));
  const pendingById = new Map(input.pending.map((entry) => [entry.mutationId, entry]));
  const quarantineById = new Map<string, QuarantineRecord>();
  for (const entry of input.quarantined) quarantineById.set(entry.mutationId, entry);

  const records: OperatorRecoveryRecord[] = [];
  const seen = new Set<string>();
  const push = (record: OperatorRecoveryRecord): void => {
    if (seen.has(record.mutationId)) return;
    seen.add(record.mutationId);
    records.push(Object.freeze(record));
  };

  for (const pending of input.pending) {
    const confirmed = confirmedById.get(pending.mutationId);
    if (confirmed) {
      push({ mutationId: pending.mutationId, state: 'confirmed', createdAt: confirmed.confirmedAt, saleId: confirmed.saleId });
      continue;
    }
    const quarantined = quarantineById.get(pending.mutationId);
    if (quarantined) {
      push({
        mutationId: pending.mutationId,
        state: classifyQuarantineReason(quarantined.reason),
        createdAt: pending.createdAt,
        reason: quarantined.reason,
      });
      continue;
    }
    push({
      mutationId: pending.mutationId,
      state: input.replayingMutationId === pending.mutationId ? 'replaying' : 'pending',
      createdAt: pending.createdAt,
    });
  }

  for (const quarantined of input.quarantined) {
    if (confirmedById.has(quarantined.mutationId) || pendingById.has(quarantined.mutationId)) continue;
    push({
      mutationId: quarantined.mutationId,
      state: classifyQuarantineReason(quarantined.reason),
      createdAt: quarantined.quarantinedAt,
      reason: quarantined.reason,
    });
  }

  for (const confirmed of input.confirmed) {
    push({ mutationId: confirmed.mutationId, state: 'confirmed', createdAt: confirmed.confirmedAt, saleId: confirmed.saleId });
  }

  return Object.freeze(records);
}

export function createDeviceOfflineRecovery(
  queue: {
    pending(): ReadonlyArray<PendingRecord>;
    quarantined(): ReadonlyArray<QuarantineRecord>;
    confirmed(): ReadonlyArray<ConfirmedRecord>;
  },
  options?: { replayingMutationId?: string | null },
) {
  return {
    snapshot(): readonly OperatorRecoveryRecord[] {
      return projectOperatorRecovery({
        pending: queue.pending(),
        quarantined: queue.quarantined(),
        confirmed: queue.confirmed(),
        replayingMutationId: options?.replayingMutationId ?? null,
      });
    },
  };
}
