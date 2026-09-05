import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyncQueuePanel } from "./SyncQueuePanel";

const mocks = vi.hoisted(() => ({
  processSyncQueue: vi.fn(async () => undefined),
  getQueueItems: vi.fn(async () => [] as any[]),
  discardItem: vi.fn(async () => undefined),
  retryItem: vi.fn(async () => undefined),
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

  it("requeues and processes a review item only after explicit operator retry", async () => {
    render(<SyncQueuePanel open onOpenChange={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: /retry pos sale/i });

    fireEvent.click(retry);

    await waitFor(() => expect(mocks.retryItem).toHaveBeenCalledWith(2));
    expect(mocks.processSyncQueue).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before discarding an unresolved financial operation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SyncQueuePanel open onOpenChange={vi.fn()} />);
    const discard = await screen.findByRole("button", { name: /discard pos sale/i });

    fireEvent.click(discard);

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/cannot be undone/i));
    expect(mocks.discardItem).not.toHaveBeenCalled();
  });
});
