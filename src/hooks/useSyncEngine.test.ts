import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncEngine } from "./useSyncEngine";
import { db } from "@/lib/db";
import { useNetworkStore } from "@/stores/network";
import { useTenantStore } from "@/stores/tenant";

const authState = vi.hoisted(() => ({ roles: [{ role: 'manager', branch_id: 'b1' }] }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: "operation-id", error: null }),
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'manager-1' } }, error: null })) },
    from: vi.fn(() => {
      const chain: any = {
        insert: vi.fn(() => chain), select: vi.fn(() => chain), eq: vi.fn(() => chain),
        single: vi.fn(async () => ({ data: {}, error: null })),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: authState.roles, error: null }),
      };
      return chain;
    }),
  },
}));

let mockDbStore: any[] = [];
vi.mock("@/lib/db", () => ({
  db: {
    sync_queue: {
      clear: vi.fn().mockImplementation(async () => { mockDbStore = []; }),
      add: vi.fn().mockImplementation(async (item) => {
        const id = mockDbStore.length + 1;
        mockDbStore.push({ ...item, id });
        return id;
      }),
      toArray: vi.fn().mockImplementation(async () => mockDbStore),
      where: vi.fn().mockReturnValue({
        anyOf: vi.fn((...statuses: string[]) => ({
          count: vi.fn().mockImplementation(async () =>
            mockDbStore.filter((item) => statuses.includes(item.status)).length
          ),
        })),
      }),
      get: vi.fn().mockImplementation(async (id) => mockDbStore.find((item) => item.id === id)),
      delete: vi.fn().mockImplementation(async (id) => {
        mockDbStore = mockDbStore.filter((item) => item.id !== id);
      }),
      update: vi.fn().mockImplementation(async (id, changes) => {
        const item = mockDbStore.find((candidate) => candidate.id === id);
        if (item) Object.assign(item, changes);
      }),
    },
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => children as any;

const expectedKitchenReplay = {
  _tenant_id: "t1", _branch_id: "b1", _order_id: "order-1",
  _operation_id: "0f4cb42e-3e9c-4d4a-b98a-c2ec04b52d7d", _action: "send_to_kitchen",
};

async function enqueue(overrides: Record<string, unknown> = {}) {
  return db.sync_queue.add({
    type: "SEND_TO_KITCHEN",
    payload: {
      _order_id: "order-1",
      _client_mutation_id: "0f4cb42e-3e9c-4d4a-b98a-c2ec04b52d7d",
    },
    tenantId: "t1",
    branchId: "b1",
    status: "queued",
    createdAt: "2026-09-05T10:00:00.000Z",
    retryCount: 0,
    clientMutationId: "0f4cb42e-3e9c-4d4a-b98a-c2ec04b52d7d",
    ...overrides,
  } as any);
}

describe("useSyncEngine", () => {
  beforeEach(async () => {
    await db.sync_queue.clear();
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    useNetworkStore.setState({ isOnline: true, pendingSyncCount: 0, syncAttentionCount: 0 });
    useTenantStore.setState({ tenantId: "t1", branchId: "b1" });
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any).mockReset().mockResolvedValue({ data: "operation-id", error: null });
    authState.roles = [{ role: 'manager', branch_id: 'b1' }];
  });

  it("exposes queue inspection, retry, discard, and reconciliation controls", () => {
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    expect(typeof result.current.processSyncQueue).toBe("function");
    expect(typeof result.current.getQueueItems).toBe("function");
    expect(typeof result.current.discardItem).toBe("function");
    expect(typeof result.current.retryItem).toBe("function");
    expect(typeof result.current.resolveReviewItem).toBe("function");
  });

  it("replays a permitted kitchen command with only SQL arguments, preserving committed evidence", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const id = await enqueue();
    const originalPayload = structuredClone(mockDbStore[0].payload);
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => result.current.processSyncQueue());
    expect(supabase.rpc).toHaveBeenCalledWith("transition_table_order_v2", expectedKitchenReplay);
    expect(mockDbStore).toHaveLength(1);
    expect(mockDbStore[0]).toMatchObject({ id, status: "committed", retryCount: 0, serverResult: "operation-id", payload: originalPayload });
    expect(mockDbStore[0].committedAt).toEqual(expect.any(String));
    expect(useNetworkStore.getState().pendingSyncCount).toBe(0);
  });

  it("replays a crash-left sending permitted command with the same order identity", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    await enqueue({ status: "sending" });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => result.current.processSyncQueue());
    expect(supabase.rpc).toHaveBeenCalledWith("transition_table_order_v2", expectedKitchenReplay);
    expect(mockDbStore[0].status).toBe("committed");
  });

  it("replays send-to-cashier through the scoped lifecycle boundary", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    await enqueue({ type:"SEND_TO_CASHIER" });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => result.current.processSyncQueue());
    expect(supabase.rpc).toHaveBeenCalledWith("transition_table_order_lifecycle_v2", {
      ...expectedKitchenReplay,
      _action:"send_to_cashier",
    });
    expect(mockDbStore[0]).toMatchObject({ status:"committed",serverResult:"operation-id" });
  });

  it("recovers a permitted operation whose first response was lost", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any)
      .mockResolvedValueOnce({ data: null, error: new TypeError("Failed to fetch") })
      .mockResolvedValueOnce({ data: "original-operation-id", error: null });
    await enqueue();
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => result.current.processSyncQueue());
    expect(mockDbStore[0]).toMatchObject({ status: "retrying", failureCode: "network", retryCount: 1 });
    await act(async () => result.current.processSyncQueue());
    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    expect(supabase.rpc).toHaveBeenNthCalledWith(1, "transition_table_order_v2", expectedKitchenReplay);
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, "transition_table_order_v2", expectedKitchenReplay);
    expect(mockDbStore[0]).toMatchObject({ status: "committed", serverResult: "original-operation-id", retryCount: 1 });
  });

  it("does not replay committed evidence a second time", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    await enqueue({ status: "committed", committedAt: "2026-09-05T10:01:00.000Z" });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => result.current.processSyncQueue());
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("never exposes or replays another tenant's queued operation", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    await enqueue();
    await enqueue({
      tenantId: "t2", branchId: "b2",
      payload: { _order_id: "order-2", _client_mutation_id: "8c946033-0ac9-4ee0-96c9-94e19350ad1f" },
      clientMutationId: "8c946033-0ac9-4ee0-96c9-94e19350ad1f",
    });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    const visibleItems = await result.current.getQueueItems();
    await act(async () => result.current.processSyncQueue());
    expect(visibleItems).toHaveLength(1);
    expect(visibleItems[0].tenantId).toBe("t1");
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockDbStore.find((item) => item.tenantId === "t2")?.status).toBe("queued");
  });

  it("preserves a queued operation for another branch without replaying it", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    await enqueue({ branchId: "b2" });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => result.current.processSyncQueue());
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(mockDbStore[0].status).toBe("queued");
  });

  it("serializes concurrent permitted sync triggers", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    await enqueue();
    const appEngine = renderHook(() => useSyncEngine(), { wrapper });
    const panelEngine = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => {
      await Promise.all([appEngine.result.current.processSyncQueue(), panelEngine.result.current.processSyncQueue()]);
    });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockDbStore[0].status).toBe("committed");
  });

  it.each([
    ["The selected cash session is not open for this branch", "cash_session_closed"],
    ["Product p1 is unavailable for this branch", "product_unavailable"],
    ["Payments (1128 fils) must exactly equal sale total (1250 fils)", "payment_mismatch"],
  ])("moves rejected permitted commands to review without automatic retries: %s", async (message, failureCode) => {
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any).mockResolvedValueOnce({ data: null, error: { message } });
    await enqueue();
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => result.current.processSyncQueue());
    await act(async () => result.current.processSyncQueue());
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockDbStore[0]).toMatchObject({ status: "requires_review", failureCode, retryCount: 1 });
  });

  it("marks an unknown operation for review instead of deleting it", async () => {
    await enqueue({ type: "UNKNOWN_OPERATION" });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => result.current.processSyncQueue());
    expect(mockDbStore).toHaveLength(1);
    expect(mockDbStore[0]).toMatchObject({ status: "requires_review", failureCode: "unknown_operation", retryCount: 1 });
  });

  it("preserves immutable review evidence while recording an explicit reconciliation disposition", async () => {
    const payload = { _tenant_id: "t1", _branch_id: "b1", exact: "evidence" };
    const id = await enqueue({ type: "UNKNOWN_OPERATION", payload });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => result.current.processSyncQueue());
    await act(async () => result.current.retryItem(id));
    expect(mockDbStore[0].status).toBe("requires_review");
    await act(async () => result.current.discardItem(id));
    expect(mockDbStore).toHaveLength(1);
    await act(async () => result.current.resolveReviewItem(
      id, "reconciled_externally", "Matched external reference Z-1042"
    ));
    expect(mockDbStore[0]).toMatchObject({
      status: "resolved",
      payload,
      reconciliationDisposition: "reconciled_externally",
      reconciliationNote: "Matched external reference Z-1042",
      resolvedAt: expect.any(String),
      resolvedBy: "manager-1",
    });
  });

  it("denies reconciliation to a non-manager without altering evidence", async () => {
    authState.roles = [{ role: 'cashier', branch_id: 'b1' }];
    const id = await enqueue({ type: "UNKNOWN_OPERATION" });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => result.current.processSyncQueue());
    await expect(act(async () => result.current.resolveReviewItem(
      id, "confirmed_not_applied", "Checked server journal"
    ))).rejects.toThrow(/owner, admin, or manager/i);
    expect(mockDbStore[0]).toMatchObject({ status: "requires_review" });
    expect(mockDbStore[0].reconciliationDisposition).toBeUndefined();
  });

  it("marks exhausted network retries failed and permits an explicit retry", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any).mockResolvedValueOnce({ data: null, error: new TypeError("Failed to fetch") });
    const id = await enqueue({ status: "retrying", retryCount: 4 });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await act(async () => result.current.processSyncQueue());
    expect(mockDbStore[0]).toMatchObject({ status: "failed", failureCode: "retry_exhausted", retryCount: 5 });
    await act(async () => result.current.retryItem(id));
    expect(mockDbStore[0]).toMatchObject({ status: "queued", retryCount: 0 });
  });

  it.each(["CHECKOUT_SALE_V2", "CHECKOUT_SALE", "CHECKOUT_TABLE_ORDER", "APPLY_INVENTORY_MOVEMENT", "ADD_TABLE_ORDER_ITEMS"])(
    "quarantines already persisted %s without RPC, deletion or payload alteration", async (type) => {
      const { supabase } = await import("@/integrations/supabase/client");
      const payload = { _tenant_id: "t1", _branch_id: "b1", _items: [], _payments: [] };
      await enqueue({ type, payload, clientMutationId: "legacy-id" });
      const originalPayload = structuredClone(mockDbStore[0].payload);
      const { result } = renderHook(() => useSyncEngine(), { wrapper });
      await act(async () => result.current.processSyncQueue());
      await act(async () => result.current.processSyncQueue());
      expect(supabase.rpc).not.toHaveBeenCalled();
      expect(mockDbStore).toHaveLength(1);
      expect(mockDbStore[0]).toMatchObject({
        status: "requires_review", failureCode: "authorization", retryCount: 1,
        clientMutationId: "legacy-id", payload: originalPayload,
      });
      expect(mockDbStore[0].committedAt).toBeUndefined();
      expect(useNetworkStore.getState().syncAttentionCount).toBe(1);
    },
  );
});
