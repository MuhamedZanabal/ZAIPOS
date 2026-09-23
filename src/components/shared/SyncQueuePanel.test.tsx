import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyncQueuePanel } from "./SyncQueuePanel";

const mocks = vi.hoisted(() => ({
  processSyncQueue: vi.fn(async () => undefined),
  getQueueItems: vi.fn(async () => [] as any[]),
  discardItem: vi.fn(async () => undefined),
  retryItem: vi.fn(async () => undefined),
  resolveReviewItem: vi.fn(async () => undefined),
}));

vi.mock("@/hooks/useSyncEngine", () => ({
  useSyncEngine: () => mocks,
}));

describe("SyncQueuePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getQueueItems.mockResolvedValue([
      {
        id: 1,
        type: "CHECKOUT_SALE_V2",
        payload: {},
        status: "committed",
        createdAt: "2026-09-05T10:00:00.000Z",
        committedAt: "2026-09-05T10:01:00.000Z",
        retryCount: 0,
        serverResult: "sale-id",
      },
      {
        id: 2,
        type: "CHECKOUT_SALE_V2",
        payload: {},
        status: "requires_review",
        createdAt: "2026-09-05T10:02:00.000Z",
        retryCount: 1,
        failureCode: "cash_session_closed",
        error: "The selected cash session is not open for this branch",
      },
    ]);
  });

  it("shows durable committed evidence and actionable review details in English", async () => {
    render(<SyncQueuePanel open onOpenChange={vi.fn()} />);

    expect(await screen.findByText("Committed")).toBeInTheDocument();
    expect(screen.getByText("Requires review")).toBeInTheDocument();
    expect(screen.getByText("Cash session closed")).toBeInTheDocument();
    expect(screen.getByText(/selected cash session is not open/i)).toBeInTheDocument();
    expect(screen.queryByText(/fallido|sincronizar|dispositivo|descartar/i)).not.toBeInTheDocument();
  });

  it("does not offer retry or discard for immutable review records", async () => {
    render(<SyncQueuePanel open onOpenChange={vi.fn()} />);
    await screen.findByText("Requires review");
    expect(screen.queryByRole("button", { name: /retry pos sale/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /discard pos sale/i })).not.toBeInTheDocument();
  });

  it("records an explicit reconciliation disposition and operator note", async () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Verified against register Z-1042");
    render(<SyncQueuePanel open onOpenChange={vi.fn()} />);
    const reconcile = await screen.findByRole("button", { name: /mark reconciled pos sale/i });

    fireEvent.click(reconcile);

    expect(prompt).toHaveBeenCalledWith(expect.stringMatching(/external transaction/i));
    await waitFor(() => expect(mocks.resolveReviewItem).toHaveBeenCalledWith(
      2, "reconciled_externally", "Verified against register Z-1042"
    ));
  });
});
