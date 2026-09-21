import type { DeviceAuthorization } from '../types.js';
import { projectOperatorRecovery, type OperatorRecoveryRecord } from './device-offline-recovery.js';

type CaptureInput = {
  authorization: DeviceAuthorization;
  kind: 'checkout.sale';
  payload: Record<string, unknown>;
  mutationId?: string;
  now?: Date;
};

type ReconciliationResult = {
  status: 'empty' | 'committed' | 'retained' | 'quarantined';
  mutationId?: string;
  saleId?: string;
};

type OfflineQueue = {
  enqueue(input: CaptureInput): string;
  pending(): ReadonlyArray<{ mutationId: string; createdAt: string }>;
  quarantined(): ReadonlyArray<{ mutationId: string; reason: string; quarantinedAt: string }>;
  confirmed(): ReadonlyArray<{ mutationId: string; saleId: string; confirmedAt: string }>;
  reconcileNext(authorization: DeviceAuthorization): Promise<ReconciliationResult>;
};

export type OfflineDrainSummary = Readonly<{
  attempted: number;
  committed: number;
  quarantined: number;
  retained: number;
  remaining: number;
}>;

export function createDeviceOfflineOrchestrator(queue: OfflineQueue, options: { enabled: boolean }) {
  const enabled = options.enabled === true;
  let activeDrain: Promise<OfflineDrainSummary> | null = null;
  let replayingMutationId: string | null = null;
  const requireEnabled = (): void => {
    if (!enabled) throw new Error('Offline checkout is disabled pending production acceptance');
  };
  const drainOnce = async (authorization: DeviceAuthorization): Promise<OfflineDrainSummary> => {
    const startingCount = queue.pending().length;
    let attempted = 0;
    let committed = 0;
    let quarantined = 0;
    let retained = 0;
    for (let index = 0; index < startingCount; index += 1) {
      replayingMutationId = queue.pending()[0]?.mutationId ?? null;
      try {
        const result = await queue.reconcileNext(authorization);
        if (result.status === 'empty') break;
        attempted += 1;
        if (result.status === 'committed') committed += 1;
        if (result.status === 'quarantined') quarantined += 1;
        if (result.status === 'retained') { retained += 1; break; }
      } finally {
        replayingMutationId = null;
      }
    }
    return Object.freeze({ attempted, committed, quarantined, retained, remaining: queue.pending().length });
  };
  return {
    enabled,
    capture(input: CaptureInput): string {
      requireEnabled();
      const mutationId = queue.enqueue(input);
      if (!queue.pending().some((item) => item.mutationId === mutationId) && !queue.confirmed().some((item) => item.mutationId === mutationId)) {
        throw new Error('Offline mutation capture was not persisted');
      }
      return mutationId;
    },
    recovery(): readonly OperatorRecoveryRecord[] {
      return projectOperatorRecovery({
        pending: queue.pending(),
        quarantined: queue.quarantined(),
        confirmed: queue.confirmed(),
        replayingMutationId,
      });
    },
    async drain(authorization: DeviceAuthorization): Promise<OfflineDrainSummary> {
      requireEnabled();
      if (activeDrain) return activeDrain;
      activeDrain = drainOnce(authorization).finally(() => { activeDrain = null; });
      return activeDrain;
    },
  };
}
