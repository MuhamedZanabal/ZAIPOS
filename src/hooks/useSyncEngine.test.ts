import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncEngine } from "./useSyncEngine";
import { db } from "@/lib/db";
import { useNetworkStore } from "@/stores/network";
import { useTenantStore } from "@/stores/tenant";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: "sale-id", error: null }),
    from: vi.fn(() => ({
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: {}, error: null }),
    })),
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

async function enqueue(overrides: Record<string, unknown> = {}) {
  return db.sync_queue.add({
    type: "CHECKOUT_SALE_V2",
    payload: {
      _tenant_id: "t1",
      _branch_id: "b1",
      _items: [{ product_id: "p1", quantity: 1, discount_fils: 0, modifiers: [] }],
      _payments: [{ method: "cash", amount_fils: 1128, reference: null }],
      _client_mutation_id: "0f4cb42e-3e9c-4d4a-b98a-c2ec04b52d7d",
    },
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
    (supabase.rpc as any).mockReset().mockResolvedValue({ data: "sale-id", error: null });
  });

  it("exposes queue inspection, discard, and explicit retry controls", () => {
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    expect(typeof result.current.processSyncQueue).toBe("function");
    expect(typeof result.current.getQueueItems).toBe("function");
    expect(typeof result.current.discardItem).toBe("function");
    expect(typeof result.current.retryItem).toBe("function");
  });

  it("replays checkout v2 unchanged and retains committed evidence", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const id = await enqueue();
    const originalPayload = structuredClone(mockDbStore[0].payload);
    const { result } = renderHook(() => useSyncEngine(), { wrapper });

    await act(async () => result.current.processSyncQueue());

    expect(supabase.rpc).toHaveBeenCalledWith("checkout_sale_v2", originalPayload);
    expect(mockDbStore).toHaveLength(1);
    expect(mockDbStore[0]).toMatchObject({
      id,
      status: "committed",
      retryCount: 0,
      serverResult: "sale-id",
    });
    expect(mockDbStore[0].committedAt).toEqual(expect.any(String));
    expect(useNetworkStore.getState().pendingSyncCount).toBe(0);
  });

  it("replays a crash-left sending checkout with the same operation ID", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    await enqueue({ status: "sending" });
    const payload = structuredClone(mockDbStore[0].payload);
    const { result } = renderHook(() => useSyncEngine(), { wrapper });

    await act(async () => result.current.processSyncQueue());

    expect(supabase.rpc).toHaveBeenCalledWith("checkout_sale_v2", payload);
    expect(mockDbStore[0].status).toBe("committed");
  });

  it("recovers when checkout committed but its first response was lost", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any)
      .mockResolvedValueOnce({ data: null, error: new TypeError("Failed to fetch") })
      .mockResolvedValueOnce({ data: "original-sale-id", error: null });
    await enqueue();
    const payload = structuredClone(mockDbStore[0].payload);
    const { result } = renderHook(() => useSyncEngine(), { wrapper });

    await act(async () => result.current.processSyncQueue());
    expect(mockDbStore[0]).toMatchObject({
      status: "retrying",
      failureCode: "network",
      retryCount: 1,
    });

    await act(async () => result.current.processSyncQueue());

    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    expect(supabase.rpc).toHaveBeenNthCalledWith(1, "checkout_sale_v2", payload);
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, "checkout_sale_v2", payload);
    expect(mockDbStore[0]).toMatchObject({
      status: "committed",
      serverResult: "original-sale-id",
      retryCount: 1,
    });
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
      payload: {
        _tenant_id: "t2",
        _branch_id: "b2",
        _client_mutation_id: "8c946033-0ac9-4ee0-96c9-94e19350ad1f",
      },
      clientMutationId: "8c946033-0ac9-4ee0-96c9-94e19350ad1f",
    });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });

    const visibleItems = await result.current.getQueueItems();
    await act(async () => result.current.processSyncQueue());

    expect(visibleItems).toHaveLength(1);
    expect(visibleItems[0].payload._tenant_id).toBe("t1");
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockDbStore.find((item) => item.payload._tenant_id === "t2")?.status).toBe("queued");
  });

  it("serializes concurrent sync triggers from the app and queue panel", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    await enqueue();
    const appEngine = renderHook(() => useSyncEngine(), { wrapper });
    const panelEngine = renderHook(() => useSyncEngine(), { wrapper });

    await act(async () => {
      await Promise.all([
        appEngine.result.current.processSyncQueue(),
        panelEngine.result.current.processSyncQueue(),
      ]);
    });

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockDbStore[0].status).toBe("committed");
  });

  it.each([
    ["The selected cash session is not open for this branch", "cash_session_closed"],
    ["Product p1 is unavailable for this branch", "product_unavailable"],
    ["Payments (1128 fils) must exactly equal sale total (1250 fils)", "payment_mismatch"],
  ])("moves a stale checkout to review without automatic retries: %s", async (message, failureCode) => {
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any).mockResolvedValueOnce({ data: null, error: { message } });
    await enqueue();
    const { result } = renderHook(() => useSyncEngine(), { wrapper });

    await act(async () => result.current.processSyncQueue());
    await act(async () => result.current.processSyncQueue());

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockDbStore[0]).toMatchObject({
      status: "requires_review",
      failureCode,
      retryCount: 1,
    });
  });

  it("marks an unknown operation for review instead of deleting it", async () => {
    await enqueue({
      type: "UNKNOWN_OPERATION",
      payload: { _tenant_id: "t1", _branch_id: "b1" },
    });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });

    await act(async () => result.current.processSyncQueue());

    expect(mockDbStore).toHaveLength(1);
    expect(mockDbStore[0]).toMatchObject({
      status: "requires_review",
      failureCode: "unknown_operation",
      retryCount: 1,
    });
  });

  it("marks exhausted network retries failed and permits an explicit retry", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any).mockResolvedValueOnce({
      data: null,
      error: new TypeError("Failed to fetch"),
    });
    const id = await enqueue({ status: "retrying", retryCount: 4 });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });

    await act(async () => result.current.processSyncQueue());
    expect(mockDbStore[0]).toMatchObject({
      status: "failed",
      failureCode: "retry_exhausted",
      retryCount: 5,
    });

    await act(async () => result.current.retryItem(id));
    expect(mockDbStore[0]).toMatchObject({ status: "queued", retryCount: 0 });
  });

  it("preserves the legacy checkout route while retaining its result", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const payload = { _tenant_id: "t1", _branch_id: "b1", _items: [], _payments: [] };
    await enqueue({ type: "CHECKOUT_SALE", payload, clientMutationId: "legacy-id" });
    const { result } = renderHook(() => useSyncEngine(), { wrapper });

    await act(async () => result.current.processSyncQueue());

    expect(supabase.rpc).toHaveBeenCalledWith("checkout_sale", payload);
    expect(mockDbStore[0]).toMatchObject({ status: "committed", serverResult: "sale-id" });
  });
});
