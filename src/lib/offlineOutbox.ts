import { supabase } from "@/integrations/supabase/client";
import { executeCashMovement, readCashMovement } from "@/lib/cashMovementRecovery";

/**
 * Durable outbox for till operations that must not be lost while the ZAIPOS
 * server is unreachable (refunds today; cash movements use their own
 * crash-safe draft and are replayed from it). Every entry carries the
 * server idempotency key (client_mutation_id / reference), so replaying an
 * entry that actually reached the server is harmless.
 */
export type OutboxKind = "sale-return" | "table-checkout";
export interface OutboxEntry {
  id: string; kind: OutboxKind; payload: Record<string, unknown>;
  tenantId: string; branchId: string; createdAt: string;
  attempts: number; state: "pending" | "conflict"; lastError: string | null;
}

const KEY = "zaipos:outbox:v1";
const CASH_PREFIX = "zaipos:cash-movement:v1:";

export function isServerUnreachable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : String(error ?? "");
  return /LOCAL_RUNTIME_UNAVAILABLE|fetch failed|failed to fetch|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|network ?error|unreachable|timed out/i.test(message);
}

export function readOutbox(): OutboxEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOutbox(entries: OutboxEntry[]): void {
  const raw = JSON.stringify(entries);
  localStorage.setItem(KEY, raw);
  if (localStorage.getItem(KEY) !== raw) throw new Error("Offline outbox could not be saved on this till");
}

export function enqueue(entry: Omit<OutboxEntry, "createdAt" | "attempts" | "state" | "lastError">): OutboxEntry {
  const entries = readOutbox();
  const existing = entries.find((e) => e.id === entry.id);
  if (existing) return existing;
  const saved: OutboxEntry = { ...entry, createdAt: new Date().toISOString(), attempts: 0, state: "pending", lastError: null };
  writeOutbox([...entries, saved]);
  return saved;
}

export function pendingCount(): number {
  return readOutbox().filter((e) => e.state === "pending").length;
}

type Executor = (entry: OutboxEntry, accessToken: string) => Promise<unknown>;

const executors: Record<OutboxKind, Executor> = {
  "sale-return": (entry, accessToken) => {
    if (!window.electron?.returnSale) throw new Error("LOCAL_RUNTIME_UNAVAILABLE");
    return window.electron.returnSale(entry.payload, { accessToken, tenantId: entry.tenantId, branchId: entry.branchId });
  },
  // Idempotent: the payload carries _client_mutation_id "table-checkout:<orderId>".
  "table-checkout": (entry, accessToken) => {
    if (!window.electron?.checkoutTableOrder) throw new Error("LOCAL_RUNTIME_UNAVAILABLE");
    return window.electron.checkoutTableOrder(entry.payload as never, { accessToken, tenantId: entry.tenantId, branchId: entry.branchId });
  },
};

export interface ReplayResult { synced: number; conflicts: number; stillPending: number }

/**
 * Sends pending entries oldest first. Stops at the first "server unreachable"
 * error; any other error marks that entry as a conflict for a manager to review
 * (it is kept, never silently dropped).
 */
export async function replayOutbox(run: Record<OutboxKind, Executor> = executors): Promise<ReplayResult> {
  const result: ReplayResult = { synced: 0, conflicts: 0, stillPending: 0 };
  const run1 = async () => {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    let entries = readOutbox();
    if (!accessToken) { result.stillPending = entries.filter((e) => e.state === "pending").length; return; }
    for (const entry of entries.filter((e) => e.state === "pending")) {
      try {
        await run[entry.kind](entry, accessToken);
        entries = readOutbox().filter((e) => e.id !== entry.id);
        writeOutbox(entries);
        result.synced++;
      } catch (error) {
        entries = readOutbox();
        const current = entries.find((e) => e.id === entry.id);
        if (!current) continue;
        current.attempts++;
        current.lastError = error instanceof Error ? error.message : String(error);
        if (isServerUnreachable(error)) { writeOutbox(entries); break; }
        current.state = "conflict";
        writeOutbox(entries);
        result.conflicts++;
      }
    }
    result.stillPending = readOutbox().filter((e) => e.state === "pending").length;
  };
  if (typeof navigator !== "undefined" && navigator.locks) await navigator.locks.request(KEY, run1);
  else await run1();
  return result;
}

/** Re-sends any cash movement whose crash-safe draft is still pending. */
export async function replayPendingCashMovements(): Promise<number> {
  let synced = 0;
  const actors: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(CASH_PREFIX)) actors.push(k.slice(CASH_PREFIX.length));
  }
  for (const actorId of actors) {
    try {
      const draft = readCashMovement(actorId);
      if (draft?.state !== "pending") continue;
      const done = await executeCashMovement(actorId, draft.request);
      if (done.state === "recorded") synced++;
    } catch {
      // stays pending; the cash screen shows recovery for this actor
    }
  }
  return synced;
}
