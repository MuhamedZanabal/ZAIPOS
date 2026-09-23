import { randomUUID } from 'node:crypto';
import type { DeviceOfflineLease } from '../types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_KIND_LENGTH = 64;

function requiredUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function requiredKind(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_KIND_LENGTH || !/^[a-z][a-z0-9_.-]*$/i.test(value)) {
    throw new Error('Invalid offline mutation kind');
  }
  return value.trim();
}

export type OfflineMutationEnvelope<T> = Readonly<{
  mutationId: string;
  leaseId: string;
  tenantId: string;
  branchId: string;
  deviceUid: string;
  kind: string;
  createdAt: string;
  payload: Readonly<T>;
}>;

/**
 * Creates the immutable identity envelope that future offline reconciliation must
 * submit. This deliberately excludes the lease token: capability material stays
 * inside Electron main-process protected custody and must never be serialized
 * into a renderer-visible/offline queue record.
 */
export function createOfflineMutationEnvelope<T extends Record<string, unknown>>(input: {
  lease: Pick<DeviceOfflineLease, 'leaseId' | 'expiresAt'>;
  tenantId: string;
  branchId: string;
  deviceUid: string;
  kind: string;
  payload: T;
  now?: Date;
  mutationId?: string;
}): OfflineMutationEnvelope<T> {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const expiresMs = Date.parse(input.lease.expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    throw new Error('Offline authority is expired');
  }

  const envelope = {
    mutationId: requiredUuid(input.mutationId ?? randomUUID(), 'offline mutation ID'),
    leaseId: requiredUuid(input.lease.leaseId, 'offline lease ID'),
    tenantId: requiredUuid(input.tenantId, 'tenant ID'),
    branchId: requiredUuid(input.branchId, 'branch ID'),
    deviceUid: typeof input.deviceUid === 'string' && input.deviceUid.trim() && input.deviceUid.length <= 128 ? input.deviceUid.trim() : (() => { throw new Error('Invalid device UID'); })(),
    kind: requiredKind(input.kind),
    createdAt: now.toISOString(),
    payload: Object.freeze({ ...input.payload }) as Readonly<T>,
  } as const;

  return Object.freeze(envelope);
}
