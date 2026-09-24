import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useNetworkStore } from "@/stores/network";
import { useTenantStore } from "@/stores/tenant";

const mocks = vi.hoisted(() => {
  const queueRows: any[] = [];
  let transactionTail = Promise.resolve();
  const add = vi.fn(async (item: any) => {
    const id = queueRows.length + 1;
    queueRows.push({ ...item, id });
    return id;
  });
  const anyOf = vi.fn((...statuses: string[]) => ({
    count: vi.fn(async () => queueRows.filter((item) => statuses.includes(item.status)).length),
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
    queueRows, add, anyOf, where, transaction, resetTransaction,
    db: { transaction, sync_queue: { add, where, toArray: vi.fn(async () => queueRows) } },
  };
});

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { isTransientNetworkError, queueOfflineMutation, useOfflineMutation } from "./useOfflineMutation";
import { toast } from "sonner";

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value });
}

const supportedType = "SEND_TO_KITCHEN";

describe("offline mutation helpers", () => {
  beforeEach(() => {
    mocks.queueRows.length = 0;
    mocks.add.mockClear();
    mocks.anyOf.mockClear();
    mocks.where.mockClear();
    mocks.transaction.mockClear();
    mocks.resetTransaction();
    vi.mocked(toast.success).mockClear();
    window.localStorage.clear();
    setNavigatorOnline(true);
    useNetworkStore.setState({ isOnline: true, pendingSyncCount: 0, syncAttentionCount: 0 });
    useTenantStore.setState({ tenantId: "tenant-1", branchId: "branch-1" });
  });

  it("detects transient network failures without hiding application errors", () => {
    expect(isTransientNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientNetworkError(new Error("Forbidden"))).toBe(false);
    setNavigatorOnline(false);
    expect(isTransientNetworkError(new Error("Forbidden"))).toBe(true);
  });

  it.each(["CHECKOUT_SALE", "CHECKOUT_SALE_V2", "CHECKOUT_TABLE_ORDER", "APPLY_INVENTORY_MOVEMENT", "ADD_TABLE_ORDER_ITEMS", "UPSERT_TABLE_ORDER_ITEMS"])(
    "denies direct credential-less or revoked %s queueing without a success receipt", async (type) => {
      const setPendingSyncCount = vi.fn();
      await expect(queueOfflineMutation(type, { _client_mutation_id: "client-1" }, setPendingSyncCount))
        .rejects.toThrow(/device credential/i);
      expect(mocks.add).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(setPendingSyncCount).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    },
  );

  it("queues a permitted order-only RPC with active tenant and branch even though SQL args have no scope", async () => {
    const setPendingSyncCount = vi.fn();
    const result = await queueOfflineMutation(
      supportedType,
      { _client_mutation_id: "client-1", _order_id: "order-1" },
      setPendingSyncCount,
    );
    expect(result).toEqual({ offline: true, queued: true });
    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(mocks.queueRows[0]).toMatchObject({
      type: supportedType,
      tenantId: "tenant-1",
      branchId: "branch-1",
      payload: { _client_mutation_id: "client-1", _order_id: "order-1" },
      status: "queued",
      retryCount: 0,
      clientMutationId: "client-1",
    });
    expect(typeof mocks.queueRows[0].deviceId).toBe("string");
    expect(setPendingSyncCount).toHaveBeenCalledWith(1);
  });

  it("fails closed without an active scope, never claiming a local save", async () => {
    useTenantStore.setState({ tenantId: null, branchId: null });
    const setPendingSyncCount = vi.fn();
    await expect(queueOfflineMutation(supportedType, { _order_id: "order-1" }, setPendingSyncCount))
      .rejects.toThrow(/active tenant and branch/i);
    expect(mocks.add).not.toHaveBeenCalled();
    expect(setPendingSyncCount).not.toHaveBeenCalled();
  });

  it("rejects a payload whose tenant or branch conflicts with the selected scope", async () => {
    const setPendingSyncCount = vi.fn();
    await expect(queueOfflineMutation(supportedType, {
      _tenant_id: "tenant-2", _branch_id: "branch-1", _order_id: "order-1",
    }, setPendingSyncCount)).rejects.toThrow(/scope conflicts/i);
    await expect(queueOfflineMutation(supportedType, {
      _tenant_id: "tenant-1", _branch_id: "branch-2", _order_id: "order-1",
    }, setPendingSyncCount)).rejects.toThrow(/scope conflicts/i);
    expect(mocks.add).not.toHaveBeenCalled();
    expect(setPendingSyncCount).not.toHaveBeenCalled();
  });

  it("deduplicates a permitted offline command by its stable operation ID", async () => {
    const setPendingSyncCount = vi.fn();
    const payload = {
      _client_mutation_id: "0f4cb42e-3e9c-4d4a-b98a-c2ec04b52d7d",
      _order_id: "order-1",
    };
    await queueOfflineMutation(supportedType, payload, setPendingSyncCount);
    await queueOfflineMutation(supportedType, payload, setPendingSyncCount);
    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(mocks.queueRows).toHaveLength(1);
    expect(mocks.queueRows[0].clientMutationId).toBe(payload._client_mutation_id);
  });

  it("rejects reuse of an operation ID with a substituted payload", async () => {
    const setPendingSyncCount = vi.fn();
    const operationId = "14226952-6024-4eaf-93cf-b1965fb1a189";
    await queueOfflineMutation(supportedType, {
      _client_mutation_id: operationId,
      _tenant_id: "tenant-1",
      _order_id: "order-1",
    }, setPendingSyncCount);
    await expect(queueOfflineMutation(supportedType, {
      _client_mutation_id: operationId,
      _tenant_id: "tenant-1",
      _order_id: "different-order",
    }, setPendingSyncCount)).rejects.toThrow(/operation id.*different.*payload/i);
    expect(mocks.queueRows).toHaveLength(1);
    expect(mocks.queueRows[0].payload._order_id).toBe("order-1");
  });

  it("rejects reuse of an operation ID after switching branches", async () => {
    const setPendingSyncCount = vi.fn();
    const payload = { _client_mutation_id: "same-operation-id", _order_id: "order-1" };
    await queueOfflineMutation(supportedType, payload, setPendingSyncCount);
    useTenantStore.setState({ tenantId: "tenant-1", branchId: "branch-2" });
    await expect(queueOfflineMutation(supportedType, payload, setPendingSyncCount))
      .rejects.toThrow(/operation id.*different.*payload/i);
    expect(mocks.queueRows).toHaveLength(1);
  });

  it("serializes concurrent permitted queue attempts by operation ID", async () => {
    const setPendingSyncCount = vi.fn();
    const payload = {
      _client_mutation_id: "8eb06e14-cf32-4d41-a11a-c16ae8b32652",
      _tenant_id: "tenant-1",
      _branch_id: "branch-1",
      _order_id: "order-1",
    };
    await Promise.all([
      queueOfflineMutation(supportedType, payload, setPendingSyncCount),
      queueOfflineMutation(supportedType, payload, setPendingSyncCount),
    ]);
    expect(mocks.queueRows).toHaveLength(1);
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["before the request", false],
    ["after the request starts", true],
  ])("queues a permitted operation when the network fails %s", async (_label, failDuringRequest) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const payload = {
      _client_mutation_id: "ca5d25bb-9eee-48d0-a233-3ef1ce806bca",
      _tenant_id: "tenant-1",
      _order_id: "order-1",
    };
    const mutationFn = vi.fn(async (_variables: typeof payload) => { throw new TypeError("Failed to fetch"); });
    if (!failDuringRequest) {
      setNavigatorOnline(false);
      useNetworkStore.setState({ isOnline: false });
    }
    const { result } = renderHook(() => useOfflineMutation({ type: supportedType, mutationFn }), { wrapper });
    let mutationResult: unknown;
    await act(async () => { mutationResult = await result.current.mutateAsync(payload); });
    expect(mutationResult).toEqual({ offline: true, queued: true });
    expect(mutationFn).toHaveBeenCalledTimes(failDuringRequest ? 1 : 0);
    expect(mocks.queueRows).toHaveLength(1);
    expect(mocks.queueRows[0]).toMatchObject({
      status: "queued",
      clientMutationId: payload._client_mutation_id,
      tenantId: "tenant-1",
      branchId: "branch-1",
      payload,
    });
  });

  it.each([
    ["CHECKOUT_SALE_V2", true],
    ["CHECKOUT_SALE_V2", false],
    ["CHECKOUT_SALE", true],
    ["CHECKOUT_SALE", false],
    ["APPLY_INVENTORY_MOVEMENT", true],
    ["APPLY_INVENTORY_MOVEMENT", false],
  ])("denies %s through the online/offline hook (online=%s) without clearing or queueing", async (type, online) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    setNavigatorOnline(online);
    useNetworkStore.setState({ isOnline: online });
    const mutationFn = vi.fn(async () => "sale-id");
    const { result } = renderHook(() => useOfflineMutation({ type, mutationFn }), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ _client_mutation_id: "safe-operation-id" }))
        .rejects.toThrow(/device credential/i);
    });
    expect(mutationFn).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("never falls back to renderer storage when a native checkout response is indeterminate", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const mutationFn = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const { result } = renderHook(() => useOfflineMutation({
      type: "CHECKOUT_SALE_V2",
      nativeDeviceCheckout: true,
      mutationFn,
    }), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({
        _client_mutation_id: "ca5d25bb-9eee-48d0-a233-3ef1ce806bca",
      })).rejects.toThrow(/result is unknown.*cart was preserved.*same sale/i);
    });
    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("persists tenant and branch scope for permitted operations", async () => {
    const setPendingSyncCount = vi.fn();
    await queueOfflineMutation(supportedType, {
      _client_mutation_id: "b133a095-192b-4595-8310-2075daf52ebc",
      _tenant_id: "tenant-1",
      _branch_id: "branch-1",
    }, setPendingSyncCount);
    expect(mocks.queueRows[0]).toMatchObject({ tenantId: "tenant-1", branchId: "branch-1" });
  });
});
