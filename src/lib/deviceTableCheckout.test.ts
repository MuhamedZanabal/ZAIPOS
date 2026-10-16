import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } }, error: null }) } } }));

import { checkoutTableOrderOnDevice } from "./deviceTableCheckout";
import { readOutbox, replayOutbox } from "./offlineOutbox";

const input = { tenantId: "t1", branchId: "b1", orderId: "o1", allocations: [{ method: "cash", amountFils: 1500 }] as never, tipAmount: 0, discountAmount: 0 };

describe("offline table checkout", () => {
  beforeEach(() => localStorage.clear());

  it("queues the checkout when the server is unreachable, once per order", async () => {
    const checkout = vi.fn().mockRejectedValue(new Error("LOCAL_RUNTIME_UNAVAILABLE"));
    (window as any).electron = { checkoutTableOrder: checkout };
    expect(await checkoutTableOrderOnDevice(input)).toEqual({ queued: true });
    expect(await checkoutTableOrderOnDevice(input)).toEqual({ queued: true });
    const entries = readOutbox();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "table-checkout:o1", kind: "table-checkout" });
    expect(entries[0].payload._client_mutation_id).toBe("table-checkout:o1");
  });

  it("does not queue business errors", async () => {
    (window as any).electron = { checkoutTableOrder: vi.fn().mockRejectedValue(new Error("Nothing has been served")) };
    await expect(checkoutTableOrderOnDevice(input)).rejects.toThrow("Nothing has been served");
    expect(readOutbox()).toHaveLength(0);
  });

  it("replays the queued checkout with the same idempotency key", async () => {
    (window as any).electron = { checkoutTableOrder: vi.fn().mockRejectedValue(new Error("fetch failed")) };
    await checkoutTableOrderOnDevice(input);
    const sent: unknown[] = [];
    const result = await replayOutbox({ "sale-return": vi.fn(), "table-checkout": async (entry) => { sent.push(entry.payload._client_mutation_id); } });
    expect(result.synced).toBe(1);
    expect(sent).toEqual(["table-checkout:o1"]);
  });
});
