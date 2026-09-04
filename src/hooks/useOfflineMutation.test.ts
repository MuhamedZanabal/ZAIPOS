import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const queueRows: any[] = [];
  const add = vi.fn(async (item: any) => {
    queueRows.push(item);
    return queueRows.length;
  });
  const anyOf = vi.fn((...statuses: string[]) => ({
    count: vi.fn(async () =>
      queueRows.filter((item) => statuses.includes(item.status)).length
    ),
  }));
  const equals = vi.fn((value: string) => ({
    first: vi.fn(async () => queueRows.find((item) => item.clientMutationId === value)),
  }));
  const where = vi.fn((field: string) => field === "clientMutationId" ? { equals } : { anyOf });

  return {
    queueRows,
    add,
    anyOf,
    equals,
    where,
    db: {
      sync_queue: { add, where },
    },
  };
});

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import {
  isTransientNetworkError,
  queueOfflineMutation,
  withClientMutationId,
} from "./useOfflineMutation";

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
}

describe("offline mutation helpers", () => {
  beforeEach(() => {
    mocks.queueRows.length = 0;
    mocks.add.mockClear();
    mocks.anyOf.mockClear();
    mocks.equals.mockClear();
    mocks.where.mockClear();
    window.localStorage.clear();
    setNavigatorOnline(true);
  });

  it("detects transient network failures without hiding application errors", () => {
    expect(isTransientNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientNetworkError(new Error("Forbidden"))).toBe(false);

    setNavigatorOnline(false);
    expect(isTransientNetworkError(new Error("Forbidden"))).toBe(true);
  });

  it("preserves a checkout mutation ID supplied before the first network attempt", () => {
    const payload = { _client_mutation_id: "checkout-stable-1", amount: 1000 };
    expect(withClientMutationId(payload, "device-1")).toBe(payload);
    expect(payload._client_mutation_id).toBe("checkout-stable-1");
  });

  it("generates an operation identity only when the caller did not supply one", () => {
    const payload = withClientMutationId({ amount: 1000 }, "device-1") as any;
    expect(payload._client_mutation_id).toMatch(/^device-1:/);
  });

  it("queues a mutation with idempotency metadata and updates the pending count", async () => {
    const setPendingSyncCount = vi.fn();

    const result = await queueOfflineMutation(
      "CHECKOUT_SALE",
      { _client_mutation_id: "client-1", amount: 1000 },
      setPendingSyncCount,
    );

    expect(result).toEqual({ offline: true, queued: true });
    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(mocks.queueRows[0]).toMatchObject({
      type: "CHECKOUT_SALE",
      payload: { _client_mutation_id: "client-1", amount: 1000 },
      status: "pending",
      retryCount: 0,
      clientMutationId: "client-1",
    });
    expect(typeof mocks.queueRows[0].deviceId).toBe("string");
    expect(setPendingSyncCount).toHaveBeenCalledWith(1);
  });

  it("does not enqueue the same checkout operation twice", async () => {
    const setPendingSyncCount = vi.fn();
    const payload = {
      _client_mutation_id: "same-checkout-id",
      _tenant_id: "t1",
      _branch_id: "b1",
    };

    await queueOfflineMutation("CHECKOUT_SALE", payload, setPendingSyncCount);
    await queueOfflineMutation("CHECKOUT_SALE", payload, setPendingSyncCount);

    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(mocks.queueRows).toHaveLength(1);
    expect(mocks.queueRows[0].clientMutationId).toBe("same-checkout-id");
  });
});
