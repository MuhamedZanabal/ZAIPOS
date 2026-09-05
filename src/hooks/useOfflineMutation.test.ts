import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useNetworkStore } from "@/stores/network";

const mocks = vi.hoisted(() => {
  const queueRows: any[] = [];
  let transactionTail = Promise.resolve();
  const add = vi.fn(async (item: any) => {
    const id = queueRows.length + 1;
    queueRows.push({ ...item, id });
    return id;
  });
  const anyOf = vi.fn((...statuses: string[]) => ({
    count: vi.fn(async () =>
      queueRows.filter((item) => statuses.includes(item.status)).length
    ),
  }));
  const equals = vi.fn((value: string) => ({
    first: vi.fn(async () => queueRows.find((item) => item.clientMutationId === value)),
  }));
  const where = vi.fn((field: string) => field === "clientMutationId"
    ? { equals }
    : { anyOf });
  const transaction = vi.fn((_mode: string, _table: unknown, scope: () => Promise<unknown>) => {
    const run = transactionTail.then(scope, scope);
    transactionTail = run.then(() => undefined, () => undefined);
    return run;
  });
  const resetTransaction = () => { transactionTail = Promise.resolve(); };

  return {
    queueRows,
    add,
    anyOf,
    where,
    transaction,
    resetTransaction,
    db: {
      transaction,
      sync_queue: { add, where, toArray: vi.fn(async () => queueRows) },
    },
  };
});

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { isTransientNetworkError, queueOfflineMutation, useOfflineMutation } from "./useOfflineMutation";

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
    mocks.where.mockClear();
    mocks.transaction.mockClear();
    mocks.resetTransaction();
    window.localStorage.clear();
    setNavigatorOnline(true);
    useNetworkStore.setState({ isOnline: true, pendingSyncCount: 0, syncAttentionCount: 0 });
  });

  it("detects transient network failures without hiding application errors", () => {
    expect(isTransientNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientNetworkError(new Error("Forbidden"))).toBe(false);

    setNavigatorOnline(false);
    expect(isTransientNetworkError(new Error("Forbidden"))).toBe(true);
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
      status: "queued",
      retryCount: 0,
      clientMutationId: "client-1",
    });
    expect(typeof mocks.queueRows[0].deviceId).toBe("string");
    expect(setPendingSyncCount).toHaveBeenCalledWith(1);
  });

  it("deduplicates an offline checkout by its stable operation ID", async () => {
    const setPendingSyncCount = vi.fn();
    const payload = {
      _client_mutation_id: "0f4cb42e-3e9c-4d4a-b98a-c2ec04b52d7d",
      _payments: [{ method: "cash", amount_fils: 1128 }],
    };

    await queueOfflineMutation("CHECKOUT_SALE_V2", payload, setPendingSyncCount);
    await queueOfflineMutation("CHECKOUT_SALE_V2", payload, setPendingSyncCount);

    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(mocks.queueRows).toHaveLength(1);
    expect(mocks.queueRows[0].clientMutationId).toBe(payload._client_mutation_id);
  });

  it("rejects reuse of an operation ID for a different checkout payload", async () => {
    const setPendingSyncCount = vi.fn();
    const operationId = "14226952-6024-4eaf-93cf-b1965fb1a189";

    await queueOfflineMutation("CHECKOUT_SALE_V2", {
      _client_mutation_id: operationId,
      _tenant_id: "tenant-1",
      _payments: [{ method: "cash", amount_fils: 1128 }],
    }, setPendingSyncCount);

    await expect(queueOfflineMutation("CHECKOUT_SALE_V2", {
      _client_mutation_id: operationId,
      _tenant_id: "tenant-1",
      _payments: [{ method: "cash", amount_fils: 2128 }],
    }, setPendingSyncCount)).rejects.toThrow(/operation id.*different.*payload/i);

    expect(mocks.queueRows).toHaveLength(1);
    expect(mocks.queueRows[0].payload._payments[0].amount_fils).toBe(1128);
  });

  it("serializes concurrent queue attempts so the same operation ID creates one row", async () => {
    const setPendingSyncCount = vi.fn();
    const payload = {
      _client_mutation_id: "8eb06e14-cf32-4d41-a11a-c16ae8b32652",
      _tenant_id: "tenant-1",
      _branch_id: "branch-1",
      _payments: [{ method: "benefitpay", amount_fils: 1128 }],
    };

    await Promise.all([
      queueOfflineMutation("CHECKOUT_SALE_V2", payload, setPendingSyncCount),
      queueOfflineMutation("CHECKOUT_SALE_V2", payload, setPendingSyncCount),
    ]);

    expect(mocks.queueRows).toHaveLength(1);
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["before the request", false],
    ["after the request starts", true],
  ])("queues the exact checkout operation when the network fails %s", async (_label, failDuringRequest) => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const payload = {
      _client_mutation_id: "ca5d25bb-9eee-48d0-a233-3ef1ce806bca",
      _tenant_id: "tenant-1",
      _payments: [{ method: "cash", amount_fils: 1128 }],
    };
    const mutationFn = vi.fn(async (_variables: typeof payload) => {
      throw new TypeError("Failed to fetch");
    });

    if (!failDuringRequest) {
      setNavigatorOnline(false);
      useNetworkStore.setState({ isOnline: false });
    }

    const { result } = renderHook(() => useOfflineMutation({
      type: "CHECKOUT_SALE_V2",
      mutationFn,
    }), { wrapper });

    let mutationResult: unknown;
    await act(async () => {
      mutationResult = await result.current.mutateAsync(payload);
    });

    expect(mutationResult).toEqual({ offline: true, queued: true });
    expect(mutationFn).toHaveBeenCalledTimes(failDuringRequest ? 1 : 0);
    expect(mocks.queueRows).toHaveLength(1);
    expect(mocks.queueRows[0]).toMatchObject({
      status: "queued",
      clientMutationId: payload._client_mutation_id,
      tenantId: "tenant-1",
      payload,
    });
  });

  it("persists tenant and branch scope beside the opaque operation payload", async () => {
    const setPendingSyncCount = vi.fn();
    await queueOfflineMutation("CHECKOUT_SALE_V2", {
      _client_mutation_id: "b133a095-192b-4595-8310-2075daf52ebc",
      _tenant_id: "tenant-1",
      _branch_id: "branch-1",
    }, setPendingSyncCount);

    expect(mocks.queueRows[0]).toMatchObject({
      tenantId: "tenant-1",
      branchId: "branch-1",
    });
  });
});
