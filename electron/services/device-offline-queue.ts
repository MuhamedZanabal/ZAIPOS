import { createHash } from 'node:crypto';
import { safeStorage } from 'electron';
import type { DeviceAuthorization, DeviceOfflineLease } from '../types.js';
import { createOfflineMutationEnvelope, type OfflineMutationEnvelope } from './device-offline-mutation.js';

type QueueStore = { get(key: string): unknown; set(key: string, value: unknown): void; delete?(key: string): void };
type OfflineAuthority = { readActive(authorization: DeviceAuthorization): DeviceOfflineLease };
type StoredMutation = Readonly<{ mutationId: string; digest: string; ciphertext: string; createdAt: string }>;
type QueueState = Readonly<{ version: 1; records: readonly StoredMutation[] }>;
type QuarantineEntry = Readonly<{ mutationId: string; reason: string; quarantinedAt: string }>;

const QUEUE_KEY = 'offline-mutation-queue-v1';
const JOURNAL_KEY = 'offline-mutation-queue-journal-v1';
const QUARANTINE_KEY = 'offline-mutation-quarantine-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENVELOPE_BYTES = 1024 * 1024;

function clear(store: QueueStore, key: string): void { if (store.delete) store.delete(key); else store.set(key, undefined); }
function requireProtection(): void { if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating-system offline queue encryption is unavailable'); }
function stateFrom(value: unknown): QueueState {
  if (value === undefined || value === null) return { version: 1, records: [] };
  if (!value || typeof value !== 'object') throw new Error('Offline queue state is corrupt');
  const candidate = value as Partial<QueueState>;
  if (candidate.version !== 1 || !Array.isArray(candidate.records)) throw new Error('Offline queue state is corrupt');
  const records = candidate.records.map((record) => {
    if (!record || typeof record !== 'object') throw new Error('Offline queue record is corrupt');
    const row = record as Partial<StoredMutation>;
    if (typeof row.mutationId !== 'string' || !UUID.test(row.mutationId) || typeof row.digest !== 'string' || !SHA256.test(row.digest)
      || typeof row.ciphertext !== 'string' || !row.ciphertext || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) {
      throw new Error('Offline queue record is corrupt');
    }
    return Object.freeze({ mutationId: row.mutationId, digest: row.digest, ciphertext: row.ciphertext, createdAt: row.createdAt });
  });
  if (new Set(records.map((record) => record.mutationId)).size !== records.length) throw new Error('Offline queue contains duplicate mutation IDs');
  return Object.freeze({ version: 1, records: Object.freeze(records) });
}
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Offline mutation payload contains a non-finite number'); return JSON.stringify(value); }
  if (typeof value !== 'object') throw new Error('Offline mutation payload is not canonical JSON');
  if (seen.has(value)) throw new Error('Offline mutation payload is cyclic');
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
  else {
    const object = value as Record<string, unknown>;
    result = `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}
function encode(envelope: OfflineMutationEnvelope<Record<string, unknown>>): StoredMutation {
  requireProtection();
  const plaintext = canonicalJson(envelope);
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_ENVELOPE_BYTES) throw new Error('Offline mutation payload exceeds the protected queue limit');
  return Object.freeze({ mutationId: envelope.mutationId, digest: digest(plaintext), ciphertext: safeStorage.encryptString(plaintext).toString('base64'), createdAt: envelope.createdAt });
}
function decode(record: StoredMutation): OfflineMutationEnvelope<Record<string, unknown>> {
  requireProtection();
  let plaintext: string;
  try { plaintext = safeStorage.decryptString(Buffer.from(record.ciphertext, 'base64')); }
  catch { throw new Error('Offline queue record cannot be decrypted'); }
  if (digest(plaintext) !== record.digest) throw new Error('Offline queue record integrity check failed');
  let envelope: any;
  try { envelope = JSON.parse(plaintext); } catch { throw new Error('Offline queue record payload is corrupt'); }
  if (!envelope || envelope.mutationId !== record.mutationId || !UUID.test(envelope.leaseId) || !UUID.test(envelope.tenantId)
    || !UUID.test(envelope.branchId) || typeof envelope.deviceUid !== 'string' || !envelope.deviceUid
    || envelope.kind !== 'checkout.sale' || !envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    throw new Error('Offline queue record payload is invalid');
  }
  return envelope;
}
function persist(store: QueueStore, next: QueueState): void {
  // A complete next-state journal makes interruption between writes recoverable.
  store.set(JOURNAL_KEY, next);
  store.set(QUEUE_KEY, next);
  clear(store, JOURNAL_KEY);
}
function quarantine(store: QueueStore, mutationId: string, reason: string, now: Date): void {
  const current = store.get(QUARANTINE_KEY);
  const entries = Array.isArray(current) ? current.filter((entry) => entry && typeof entry === 'object') as QuarantineEntry[] : [];
  entries.push(Object.freeze({ mutationId, reason: reason.slice(0, 240), quarantinedAt: now.toISOString() }));
  store.set(QUARANTINE_KEY, Object.freeze(entries));
}
function rpcUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Supabase URL must use HTTPS');
  parsed.pathname = '/rest/v1/rpc/reconcile_offline_checkout'; parsed.search = ''; parsed.hash = '';
  return parsed.href;
}

export function createDeviceOfflineQueue(store: QueueStore, authority: OfflineAuthority, baseUrl: string, publishableKey: string) {
  const recover = (): QueueState => {
    const journal = store.get(JOURNAL_KEY);
    if (journal !== undefined && journal !== null) {
      try {
        const recovered = stateFrom(journal);
        store.set(QUEUE_KEY, recovered);
        clear(store, JOURNAL_KEY);
        return recovered;
      } catch (error: any) {
        quarantine(store, 'unknown', `corrupt queue journal: ${error?.message ?? 'invalid state'}`, new Date());
        clear(store, JOURNAL_KEY);
      }
    }
    try { return stateFrom(store.get(QUEUE_KEY)); }
    catch (error: any) {
      quarantine(store, 'unknown', `corrupt queue state: ${error?.message ?? 'invalid state'}`, new Date());
      clear(store, QUEUE_KEY);
      return { version: 1, records: [] };
    }
  };
  const remove = (mutationId: string): void => {
    const current = recover();
    persist(store, { version: 1, records: current.records.filter((record) => record.mutationId !== mutationId) });
  };
  return {
    recover,
    pending(): ReadonlyArray<Pick<StoredMutation, 'mutationId' | 'createdAt'>> {
      return recover().records.map(({ mutationId, createdAt }) => Object.freeze({ mutationId, createdAt }));
    },
    quarantined(): readonly QuarantineEntry[] {
      const value = store.get(QUARANTINE_KEY); return Array.isArray(value) ? value as QuarantineEntry[] : [];
    },
    enqueue(input: { authorization: DeviceAuthorization; kind: 'checkout.sale'; payload: Record<string, unknown>; mutationId?: string; now?: Date }): string {
      const lease = authority.readActive(input.authorization);
      const enrollment = store.get('enrollment') as { deviceUid?: unknown } | undefined;
      if (typeof enrollment?.deviceUid !== 'string' || !enrollment.deviceUid.trim()) throw new Error('Trusted device identity is unavailable');
      const current = recover();
      if (input.mutationId) {
        const existing = current.records.find((item) => item.mutationId === input.mutationId);
        if (existing) {
          const previous = decode(existing);
          if (previous.leaseId !== lease.leaseId || previous.tenantId !== input.authorization.tenantId || previous.branchId !== input.authorization.branchId
            || previous.deviceUid !== enrollment.deviceUid || previous.kind !== input.kind || canonicalJson(previous.payload) !== canonicalJson(input.payload)) {
            throw new Error('Offline mutation ID was reused with a different payload');
          }
          return existing.mutationId;
        }
      }
      const envelope = createOfflineMutationEnvelope({ lease, tenantId: input.authorization.tenantId, branchId: input.authorization.branchId,
        deviceUid: enrollment.deviceUid, kind: input.kind, payload: input.payload, mutationId: input.mutationId, now: input.now });
      const record = encode(envelope);
      persist(store, { version: 1, records: [...current.records, record] });
      return record.mutationId;
    },
    async reconcileNext(authorization: DeviceAuthorization): Promise<{ status: 'empty' | 'committed' | 'retained' | 'quarantined'; mutationId?: string; saleId?: string }> {
      const current = recover(); const record = current.records[0]; if (!record) return { status: 'empty' };
      let envelope: OfflineMutationEnvelope<Record<string, unknown>>;
      try { envelope = decode(record); } catch (error: any) { quarantine(store, record.mutationId, error?.message ?? 'corrupt record', new Date()); remove(record.mutationId); return { status: 'quarantined', mutationId: record.mutationId }; }
      if (envelope.tenantId !== authorization.tenantId || envelope.branchId !== authorization.branchId) {
        quarantine(store, record.mutationId, 'authorization scope mismatch', new Date()); remove(record.mutationId); return { status: 'quarantined', mutationId: record.mutationId };
      }
      let lease: DeviceOfflineLease;
      try { lease = authority.readActive(authorization); }
      catch { quarantine(store, record.mutationId, 'offline authority unavailable or expired', new Date()); remove(record.mutationId); return { status: 'quarantined', mutationId: record.mutationId }; }
      if (lease.leaseId !== envelope.leaseId) { quarantine(store, record.mutationId, 'offline lease identity mismatch', new Date()); remove(record.mutationId); return { status: 'quarantined', mutationId: record.mutationId }; }
      let response: Response;
      try {
        response = await fetch(rpcUrl(baseUrl), { method: 'POST', headers: { apikey: publishableKey, authorization: `Bearer ${authorization.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...envelope.payload, _tenant_id: envelope.tenantId, _branch_id: envelope.branchId, _lease_id: envelope.leaseId,
            _lease_token: lease.token, _device_uid: envelope.deviceUid, _mutation_id: envelope.mutationId }) });
      } catch { return { status: 'retained', mutationId: record.mutationId }; }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 409 || response.status === 422) {
          quarantine(store, record.mutationId, `server rejected reconciliation (${response.status})`, new Date()); remove(record.mutationId); return { status: 'quarantined', mutationId: record.mutationId };
        }
        return { status: 'retained', mutationId: record.mutationId };
      }
      let text: string;
      try { text = await response.text(); }
      catch { return { status: 'retained', mutationId: record.mutationId }; }
      let decoded: unknown;
      try { decoded = text ? JSON.parse(text) : null; }
      catch {
        quarantine(store, record.mutationId, 'server returned malformed reconciliation JSON', new Date());
        remove(record.mutationId);
        return { status: 'quarantined', mutationId: record.mutationId };
      }
      const saleId = Array.isArray(decoded) ? decoded[0] : decoded;
      if (typeof saleId !== 'string' || !UUID.test(saleId)) { quarantine(store, record.mutationId, 'server returned an invalid sale identifier', new Date()); remove(record.mutationId); return { status: 'quarantined', mutationId: record.mutationId }; }
      remove(record.mutationId); return { status: 'committed', mutationId: record.mutationId, saleId };
    },
  };
}
