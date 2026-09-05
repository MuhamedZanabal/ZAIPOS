import type { SyncQueueItem, SyncQueueStatus } from "./db";

export const MAX_SYNC_RETRIES = 5;

export const ACTIVE_SYNC_QUEUE_STATUSES = [
  "queued",
  "sending",
  "retrying",
  "failed",
  "requires_review",
] as const satisfies readonly SyncQueueStatus[];

const REPLAYABLE_SYNC_QUEUE_STATUSES = new Set<string>([
  "queued",
  "sending",
  "retrying",
  // Defensive compatibility if a v3 row is read before the Dexie upgrade
  // transaction finishes.
  "pending",
]);

export type SyncFailureCode =
  | "network"
  | "retry_exhausted"
  | "unknown_operation"
  | "operation_conflict"
  | "branch_changed"
  | "cash_session_closed"
  | "customer_changed"
  | "product_unavailable"
  | "coupon_changed"
  | "payment_mismatch"
  | "stock_conflict"
  | "authorization"
  | "validation";

export interface SyncFailureClassification {
  status: Extract<SyncQueueStatus, "retrying" | "failed" | "requires_review">;
  failureCode: SyncFailureCode;
  retryCount: number;
  message: string;
}

export class UnknownSyncOperationError extends Error {
  constructor(type: string) {
    super(`Unknown offline operation type: ${type}`);
    this.name = "UnknownSyncOperationError";
  }
}

export function isReplayableQueueStatus(status: string) {
  return REPLAYABLE_SYNC_QUEUE_STATUSES.has(status);
}

export function isActiveQueueStatus(status: string): status is SyncQueueStatus {
  return (ACTIVE_SYNC_QUEUE_STATUSES as readonly string[]).includes(status);
}

export function syncQueueScopeFromPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return { tenantId: undefined, branchId: undefined };
  }
  const record = payload as Record<string, unknown>;
  const tenantId = record._tenant_id ?? record.tenant_id ?? record.tenantId;
  const branchId = record._branch_id ?? record.branch_id ?? record.branchId;
  return {
    tenantId: typeof tenantId === "string" ? tenantId : undefined,
    branchId: typeof branchId === "string" ? branchId : undefined,
  };
}

export function syncQueueItemBelongsToTenant(
  item: Pick<SyncQueueItem, "payload" | "tenantId">,
  tenantId: string,
) {
  return (item.tenantId ?? syncQueueScopeFromPayload(item.payload).tenantId) === tenantId;
}

export function isTransientNetworkFailure(error: unknown) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const message = syncErrorMessage(error);
  return /failed to fetch|fetch failed|networkerror|network error|load failed|err_network|internet disconnected/i.test(message);
}

export function syncErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;
    return [candidate.message, candidate.details, candidate.hint]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" · ") || String(error);
  }
  return String(error ?? "Unknown synchronization error");
}

export function classifySyncFailure(
  error: unknown,
  previousRetryCount: number,
): SyncFailureClassification {
  const retryCount = previousRetryCount + 1;
  const message = syncErrorMessage(error);

  if (isTransientNetworkFailure(error)) {
    return retryCount >= MAX_SYNC_RETRIES
      ? { status: "failed", failureCode: "retry_exhausted", retryCount, message }
      : { status: "retrying", failureCode: "network", retryCount, message };
  }

  if (error instanceof UnknownSyncOperationError) {
    return { status: "requires_review", failureCode: "unknown_operation", retryCount, message };
  }

  const normalized = message.toLowerCase();
  let failureCode: SyncFailureCode = "validation";

  if (/cash session/.test(normalized)) failureCode = "cash_session_closed";
  else if (/branch is not active|branch.*business|branch.*changed/.test(normalized)) failureCode = "branch_changed";
  else if (/customer.*does not belong|customer.*changed/.test(normalized)) failureCode = "customer_changed";
  else if (/product.*unavailable|modifiers?.*invalid|modifiers?.*unavailable/.test(normalized)) failureCode = "product_unavailable";
  else if (/coupon.*invalid|coupon.*expired|coupon.*exhausted|coupon.*unsupported/.test(normalized)) failureCode = "coupon_changed";
  else if (/payments?.*must exactly equal sale total|payment mismatch/.test(normalized)) failureCode = "payment_mismatch";
  else if (/insufficient stock|stock insuficiente|stock conflict|negative stock/.test(normalized)) failureCode = "stock_conflict";
  else if (/client mutation id.*different checkout|operation.*already processing/.test(normalized)) failureCode = "operation_conflict";
  else if (/not authenticated|forbidden|permission|not authorized|authorization/.test(normalized)) failureCode = "authorization";

  return { status: "requires_review", failureCode, retryCount, message };
}

type LegacySyncQueueItem = Omit<Partial<SyncQueueItem>, "status"> & {
  status?: string;
  createdAt: string;
};

export function migrateLegacySyncQueueItem<T extends LegacySyncQueueItem>(item: T) {
  const payloadScope = syncQueueScopeFromPayload(item.payload);
  const scopedItem = {
    ...item,
    tenantId: item.tenantId ?? payloadScope.tenantId,
    branchId: item.branchId ?? payloadScope.branchId,
  };

  if (item.status === "pending") return { ...scopedItem, status: "queued" as const };
  if (item.status === "success") {
    return {
      ...scopedItem,
      status: "committed" as const,
      committedAt: item.committedAt ?? item.updatedAt ?? item.createdAt,
    };
  }
  return scopedItem;
}
