import fs from 'node:fs';
import path from 'node:path';
import type { DeviceAuthorization } from '../types.js';

/**
 * Durable checkout outbox for the local runtime.
 *
 * When the on-premises ZAIPOS server is unreachable, a completed sale is
 * written to disk (Electron main, never the renderer) and replayed when the
 * server returns. Replays reuse the sale's `_client_mutation_id`, which the
 * server stores under UNIQUE(tenant_id, client_mutation_id), so a sale that
 * actually reached the server before the connection dropped is returned, not
 * duplicated. Secrets are never written: the device credential is attached at
 * send time and the session token is only held in memory.
 */
export type OutboxEntry = {
  mutationId: string;
  tenantId: string;
  branchId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  state: 'pending' | 'failed';
  lastError?: string;
  saleId?: string;
};
export type OutboxStatus = Readonly<{ pending: number; failed: number; failures: ReadonlyArray<{ mutationId: string; error: string; createdAt: string }> }>;
export type ReplaySummary = Readonly<{ attempted: number; committed: number; failed: number; remaining: number; saleIds: string[] }>;
type Checkout = (payload: Record<string, unknown>, authorization: DeviceAuthorization) => Promise<string>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_KEYS = new Set(['_lease_token', '_device_credential', '_device_uid', 'token', 'credential', 'accessToken', 'access_token']);

export function isLocalServerUnreachable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'LOCAL_RUNTIME_UNAVAILABLE') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /LOCAL_RUNTIME_UNAVAILABLE|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed|failed to fetch|network error/i.test(message);
}

export function createLocalCheckoutOutbox(file: string, checkout: Checkout) {
  let entries: OutboxEntry[] = load();
  let replaying: Promise<ReplaySummary> | null = null;

  function load(): OutboxEntry[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed?.entries) ? parsed.entries.filter((e: OutboxEntry) => UUID.test(e?.mutationId ?? '')) : [];
    } catch { return []; }
  }
  function persist(): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify({ version: 1, entries })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }

  function enqueue(payload: Record<string, unknown>): string {
    const mutationId = payload._client_mutation_id;
    if (typeof mutationId !== 'string' || !UUID.test(mutationId)) throw new Error('Offline sale needs a stable operation ID');
    const tenantId = String(payload._tenant_id ?? ''); const branchId = String(payload._branch_id ?? '');
    if (!UUID.test(tenantId) || !UUID.test(branchId)) throw new Error('Offline sale needs a tenant and branch');
    if (entries.some((e) => e.mutationId === mutationId)) return mutationId; // same sale retried while offline
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) if (!SECRET_KEYS.has(k)) clean[k] = v;
    entries.push({ mutationId, tenantId, branchId, payload: clean, createdAt: new Date().toISOString(), attempts: 0, state: 'pending' });
    persist();
    return mutationId;
  }

  function status(scope?: { tenantId: string; branchId: string }): OutboxStatus {
    const mine = scope ? entries.filter((e) => e.tenantId === scope.tenantId && e.branchId === scope.branchId) : entries;
    const failed = mine.filter((e) => e.state === 'failed');
    return Object.freeze({
      pending: mine.filter((e) => e.state === 'pending').length,
      failed: failed.length,
      failures: failed.map((e) => ({ mutationId: e.mutationId, error: e.lastError ?? 'Unknown error', createdAt: e.createdAt })),
    });
  }

  async function replayOnce(authorization: DeviceAuthorization): Promise<ReplaySummary> {
    let attempted = 0; let committed = 0; let failed = 0; const saleIds: string[] = [];
    const due = entries.filter((e) => e.state === 'pending' && e.tenantId === authorization.tenantId && e.branchId === authorization.branchId);
    for (const entry of due) {
      attempted += 1;
      entry.attempts += 1;
      try {
        const saleId = await checkout(entry.payload, authorization);
        entries = entries.filter((e) => e.mutationId !== entry.mutationId);
        committed += 1; saleIds.push(saleId);
        persist();
      } catch (error) {
        if (isLocalServerUnreachable(error)) { persist(); break; } // still offline; keep order
        entry.state = 'failed';
        entry.lastError = error instanceof Error ? error.message : String(error);
        failed += 1;
        persist();
      }
    }
    const remaining = entries.filter((e) => e.state === 'pending' && e.tenantId === authorization.tenantId && e.branchId === authorization.branchId).length;
    return Object.freeze({ attempted, committed, failed, remaining, saleIds });
  }

  return {
    enqueue,
    status,
    /** Serialised: concurrent callers share one replay so no entry is sent twice at once. */
    replay(authorization: DeviceAuthorization): Promise<ReplaySummary> {
      if (!replaying) replaying = replayOnce(authorization).finally(() => { replaying = null; });
      return replaying;
    },
    /** Operator decision for a sale the server rejected (e.g. register closed): retry it or discard it. */
    resolveFailed(mutationId: string, action: 'retry' | 'discard'): void {
      const entry = entries.find((e) => e.mutationId === mutationId && e.state === 'failed');
      if (!entry) throw new Error('No failed offline sale with that ID');
      if (action === 'discard') entries = entries.filter((e) => e !== entry);
      else { entry.state = 'pending'; delete entry.lastError; }
      persist();
    },
  };
}
