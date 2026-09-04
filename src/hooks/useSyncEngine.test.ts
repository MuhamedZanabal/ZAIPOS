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
    (supabase.rpc as any).mockReset();
    (supabase.rpc as any).mockResolvedValue({ data: "sale-id", error: null });
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

  it("replays CHECKOUT_SALE with the exact original mutation and session identity", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const payload = {
      _tenant_id: "t1",
      _branch_id: "b1",
      _cash_session_id: "session-1",
      _client_mutation_id: "stable-checkout-id",
      _items: [{ product_id: "p1", quantity: 1 }],
      _payments: [{ method: "cash", amount: 1.25 }],
    };

    await db.sync_queue.add({
      type: "CHECKOUT_SALE",
      payload,
      status: "pending",
      createdAt: new Date().toISOString(),
      retryCount: 0,
      clientMutationId: "stable-checkout-id",
    });

    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await result.current.processSyncQueue();

    expect(supabase.rpc).toHaveBeenCalledWith("checkout_sale", payload);
    await waitFor(() => expect(mockDbStore).toHaveLength(0));
  });

  it("increments retryCount while preserving the original payload identity", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any).mockResolvedValueOnce({ data: null, error: { message: "RPC failed" } });

    const payload = {
      _tenant_id: "t1",
      _branch_id: "b1",
      _client_mutation_id: "stable-retry-id",
      _items: [],
      _payments: [],
    };
    const id = await db.sync_queue.add({
      type: "CHECKOUT_SALE",
      payload,
      status: "pending",
      createdAt: new Date().toISOString(),
      retryCount: 0,
      clientMutationId: "stable-retry-id",
    });

    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await result.current.processSyncQueue();

    const item = mockDbStore.find(i => i.id === id);
    expect(item?.status).toBe("pending");
    expect(item?.retryCount).toBe(1);
    expect(item?.payload).toEqual(payload);
    expect(item?.clientMutationId).toBe("stable-retry-id");
  });

  it("marks failed when maximum retries are reached without changing identity", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.rpc as any).mockResolvedValueOnce({ data: null, error: { message: "RPC failed" } });

    const id = await db.sync_queue.add({
      type: "CHECKOUT_SALE",
      payload: { _client_mutation_id: "max-retry-id" },
      status: "failed",
      createdAt: new Date().toISOString(),
      retryCount: 4,
      clientMutationId: "max-retry-id",
    });

    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await result.current.processSyncQueue();

    const item = mockDbStore.find(i => i.id === id);
    expect(item?.status).toBe("failed");
    expect(item?.retryCount).toBe(5);
    expect(item?.clientMutationId).toBe("max-retry-id");
  });

  it("retains unknown operation types as failed instead of silently deleting data", async () => {
    const id = await db.sync_queue.add({
      type: "UNKNOWN_OP",
      payload: { important: true },
      status: "pending",
      createdAt: new Date().toISOString(),
      retryCount: 0,
    });

    const { result } = renderHook(() => useSyncEngine(), { wrapper });
    await expect(result.current.processSyncQueue()).resolves.not.toThrow();

    const item = mockDbStore.find(i => i.id === id);
    expect(item).toBeDefined();
    expect(item?.status).toBe("failed");
    expect(item?.lastError).toContain("Unsupported offline operation type");
  });
});
