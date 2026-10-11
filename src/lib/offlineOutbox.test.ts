import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "tok" } } }) } },
}));

import { enqueue, isServerUnreachable, pendingCount, readOutbox, replayOutbox } from "./offlineOutbox";

const entry = (id: string) => ({ id, kind: "sale-return" as const, payload: { _client_mutation_id: id }, tenantId: "t", branchId: "b" });

describe("offline outbox", () => {
  beforeEach(() => localStorage.clear());

  it("detects an unreachable server but not business rejections", () => {
    expect(isServerUnreachable(new Error("fetch failed"))).toBe(true);
    expect(isServerUnreachable({ message: "LOCAL_RUNTIME_UNAVAILABLE" })).toBe(true);
    expect(isServerUnreachable(new Error("Return quantity exceeds remaining"))).toBe(false);
  });

  it("deduplicates by idempotency key and survives reload", () => {
    enqueue(entry("return-1"));
    enqueue(entry("return-1"));
    expect(readOutbox()).toHaveLength(1);
    expect(pendingCount()).toBe(1);
  });

  it("replays in order, stops while offline, then syncs exactly once", async () => {
    enqueue(entry("r1"));
    enqueue(entry("r2"));
    const calls: string[] = [];
    const offline = vi.fn(async (e) => { calls.push(e.id); throw new Error("fetch failed"); });
    let r = await replayOutbox({ "sale-return": offline });
    expect(r).toEqual({ synced: 0, conflicts: 0, stillPending: 2 });
    expect(calls).toEqual(["r1"]);

    const online = vi.fn(async (e, token) => { calls.push(`${e.id}:${token}`); return "ok"; });
    r = await replayOutbox({ "sale-return": online });
    expect(r).toEqual({ synced: 2, conflicts: 0, stillPending: 0 });
    r = await replayOutbox({ "sale-return": online });
    expect(r.synced).toBe(0);
    expect(online).toHaveBeenCalledTimes(2);
  });

  it("keeps a server rejection as a conflict instead of dropping it", async () => {
    enqueue(entry("r1"));
    const r = await replayOutbox({ "sale-return": async () => { throw new Error("Return quantity exceeds remaining"); } });
    expect(r.conflicts).toBe(1);
    expect(readOutbox()[0]).toMatchObject({ state: "conflict", lastError: "Return quantity exceeds remaining", attempts: 1 });
    expect(pendingCount()).toBe(0);
  });
});
