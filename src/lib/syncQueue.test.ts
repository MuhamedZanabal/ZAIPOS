import { describe, expect, it } from "vitest";
import {
  ACTIVE_SYNC_QUEUE_STATUSES,
  classifySyncFailure,
  migrateLegacySyncQueueItem,
} from "./syncQueue";

describe("sync queue state policy", () => {
  it("migrates legacy pending and success rows without losing commit evidence", () => {
    expect(migrateLegacySyncQueueItem({
      status: "pending",
      createdAt: "2026-09-05T10:00:00.000Z",
      payload: { _tenant_id: "tenant-1", _branch_id: "branch-1" },
    })).toMatchObject({
      status: "queued",
      tenantId: "tenant-1",
      branchId: "branch-1",
    });

    expect(migrateLegacySyncQueueItem({
      status: "success",
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T10:01:00.000Z",
    })).toMatchObject({
      status: "committed",
      committedAt: "2026-09-05T10:01:00.000Z",
    });
  });

  it("counts every unresolved state while excluding committed evidence", () => {
    expect(ACTIVE_SYNC_QUEUE_STATUSES).toEqual([
      "queued",
      "sending",
      "retrying",
      "failed",
      "requires_review",
    ]);
    expect(ACTIVE_SYNC_QUEUE_STATUSES).not.toContain("committed");
  });

  it.each([
    ["The selected cash session is not open for this branch", "cash_session_closed"],
    ["Branch is not active for this business", "branch_changed"],
    ["Customer does not belong to this business", "customer_changed"],
    ["Product 123 is unavailable for this branch", "product_unavailable"],
    ["Coupon is invalid, expired, or exhausted", "coupon_changed"],
    ["Payments (1000 fils) must exactly equal sale total (1100 fils)", "payment_mismatch"],
    ["Insufficient stock for product 123", "stock_conflict"],
    ["Stock insuficiente para el producto 123", "stock_conflict"],
    ["Client mutation ID was already used for a different checkout request", "operation_conflict"],
    ["Forbidden", "authorization"],
  ])("sends deterministic checkout conflicts to review: %s", (message, failureCode) => {
    expect(classifySyncFailure({ message }, 0)).toMatchObject({
      status: "requires_review",
      failureCode,
      retryCount: 1,
    });
  });

  it("retries transient transport failures and fails only after the retry ceiling", () => {
    expect(classifySyncFailure(new TypeError("Failed to fetch"), 0)).toMatchObject({
      status: "retrying",
      failureCode: "network",
      retryCount: 1,
    });

    expect(classifySyncFailure(new TypeError("Failed to fetch"), 4)).toMatchObject({
      status: "failed",
      failureCode: "retry_exhausted",
      retryCount: 5,
    });
  });
});
