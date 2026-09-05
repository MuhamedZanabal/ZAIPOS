import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authSignOut: vi.fn(async () => undefined),
  queryClear: vi.fn(),
  idbClear: vi.fn(async () => undefined),
  syncQueueClear: vi.fn(async () => undefined),
  productsClear: vi.fn(async () => undefined),
  categoriesClear: vi.fn(async () => undefined),
  branchProductsClear: vi.fn(async () => undefined),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: mocks.authSignOut } },
}));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { clear: mocks.queryClear },
}));
vi.mock("idb-keyval", () => ({ clear: mocks.idbClear }));
vi.mock("@/lib/db", () => ({
  db: {
    sync_queue: { clear: mocks.syncQueueClear },
    products: { clear: mocks.productsClear },
    categories: { clear: mocks.categoriesClear },
    branch_products: { clear: mocks.branchProductsClear },
  },
}));

import { signOutFully } from "./signOut";

describe("signOutFully", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears tenant caches but preserves durable queued financial operations", async () => {
    await signOutFully();

    expect(mocks.productsClear).toHaveBeenCalledTimes(1);
    expect(mocks.categoriesClear).toHaveBeenCalledTimes(1);
    expect(mocks.branchProductsClear).toHaveBeenCalledTimes(1);
    expect(mocks.syncQueueClear).not.toHaveBeenCalled();
  });
});
