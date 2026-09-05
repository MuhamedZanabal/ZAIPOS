import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSyncEngine } from "./useSyncEngine";
import { db } from "@/lib/db";
import { useNetworkStore } from "@/stores/network";

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
        const id = Math.random();
        mockDbStore.push({ ...item, id });
        return id;
      }),
      toArray: vi.fn().mockImplementation(async () => mockDbStore),
      where: vi.fn().mockReturnValue({
        anyOf: vi.fn((...statuses: string[]) => ({
          count: vi.fn().mockImplementation(async () =>
            mockDbStore.filter((i) => statuses.includes(i.status)).length
          ),
        })),
        equals: vi.fn().mockReturnValue({
          toArray: vi.fn().mockImplementation(async () => mockDbStore.filter(i => i.status === "success")),
        }),
      }),
      get: vi.fn().mockImplementation(async (id) => mockDbStore.find(i => i.id === id)),
      delete: vi.fn().mockImplementation(async (id) => { mockDbStore = mockDbStore.filter(i => i.id !== id); }),
      update: vi.fn().mockImplementation(async (id, changes) => {
        const item = mockDbStore.find(i => i.id === id);
        if (item) Object.assign(item, changes);
      })
    }
  }
}));

const wrapper = ({ children }: { children: React.ReactNode }) => children as any;

describe("useSyncEngine", () => {
  beforeEach(async () => {
    await db.sync_queue.clear();
    useNetworkStore.setState({ isOnline: true, pendingSyncCount: 0 });
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any).mockReset().mockResolvedValue({ data: "sale-id", error: null });
  });

  it("exposes processSyncQueue, getQueueItems and discardItem", () => {
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    expect(typeof result.current.processSyncQueue).toBe("function");
    expect(typeof result.current.getQueueItems).toBe("function");
    expect(typeof result.current.discardItem).toBe("function");
  });

  it("getQueueItems returns empty array when queue is empty", async () => {
    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    const items = await result.current.getQueueItems();
    expect(items).toEqual([]);
  });

  it("getQueueItems returns items after they are enqueued", async () => {
    await db.sync_queue.add({
      type: "CHECKOUT_SALE",
      payload: { _tenant_id: "t1" },
      status: "pending",
      createdAt: new Date().toISOString(),
      retryCount: 0,
    });

    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    const items = await result.current.getQueueItems();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("CHECKOUT_SALE");
  });

  it("discardItem removes the item and updates pending count", async () => {
    const id = await db.sync_queue.add({
      type: "CHECKOUT_SALE",
      payload: {},
      status: "pending",
      createdAt: new Date().toISOString(),
      retryCount: 0,
    });

    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await result.current.discardItem(id);

    expect(mockDbStore).toHaveLength(0);
  });

  it("preserves legacy CHECKOUT_SALE replay routing", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const payload = {
      _tenant_id: "t1",
      _branch_id: "b1",
      _items: [],
      _payments: [],
    };

    await db.sync_queue.add({
      type: "CHECKOUT_SALE",
      payload,
      status: "pending",
      createdAt: new Date().toISOString(),
      retryCount: 0,
      clientMutationId: "legacy-mutation-1",
    });

    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await result.current.processSyncQueue();

    expect(supabase.rpc).toHaveBeenCalledWith("checkout_sale", payload);
    expect(mockDbStore).toHaveLength(0);
  });

  it("replays CHECKOUT_SALE_V2 through checkout_sale_v2 without rewriting its payload", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const payload = {
      _tenant_id: "t1",
      _branch_id: "b1",
      _items: [{ product_id: "p1", quantity: 1, discount_fils: 0, modifiers: [] }],
      _payments: [{ method: "cash", amount_fils: 1128, reference: null }],
      _discount_total_fils: 0,
      _tip_amount_fils: 0,
      _cash_session_id: "s1",
      _client_mutation_id: "v2-mutation-1",
    };

    await db.sync_queue.add({
      type: "CHECKOUT_SALE_V2",
      payload,
      status: "pending",
      createdAt: new Date().toISOString(),
      retryCount: 0,
      clientMutationId: "v2-mutation-1",
    });

    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await result.current.processSyncQueue();

    expect(supabase.rpc).toHaveBeenCalledWith("checkout_sale_v2", payload);
    expect(mockDbStore).toHaveLength(0);
  });

  it("increments retryCount and keeps pending before reaching the maximum", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any).mockResolvedValueOnce({ data: null, error: { message: "RPC failed" } });

    const id = await db.sync_queue.add({
      type: "CHECKOUT_SALE_V2",
      payload: { _tenant_id: "t1", _branch_id: "b1", _items: [], _payments: [] },
      status: "pending",
      createdAt: new Date().toISOString(),
      retryCount: 0,
    });

    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await result.current.processSyncQueue();

    await waitFor(async () => {
      const item = mockDbStore.find(i => i.id === id);
      expect(item?.status).toBe("pending");
      expect(item?.retryCount).toBe(1);
    });
  });

  it("marks failed when it reaches the retry maximum", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any).mockResolvedValueOnce({ data: null, error: { message: "RPC failed" } });

    const id = await db.sync_queue.add({
      type: "CHECKOUT_SALE_V2",
      payload: { _tenant_id: "t1", _branch_id: "b1", _items: [], _payments: [] },
      status: "failed",
      createdAt: new Date().toISOString(),
      retryCount: 4,
    });

    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await result.current.processSyncQueue();

    await waitFor(async () => {
      const item = mockDbStore.find(i => i.id === id);
      expect(item?.status).toBe("failed");
      expect(item?.retryCount).toBe(5);
    });
  });

  it("skips unknown operation types without crashing", async () => {
    await db.sync_queue.add({
      type: "UNKNOWN_OP",
      payload: {},
      status: "pending",
      createdAt: new Date().toISOString(),
      retryCount: 0,
    });

    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await expect(result.current.processSyncQueue()).resolves.not.toThrow();
  });
});
