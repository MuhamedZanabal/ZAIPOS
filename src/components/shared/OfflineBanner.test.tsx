import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { OfflineBanner } from "@/components/shared/OfflineBanner";
import { useNetworkStore } from "@/stores/network";

// Mock SyncQueuePanel to avoid full hook tree
vi.mock("@/components/shared/SyncQueuePanel", () => ({
  SyncQueuePanel: () => null,
}));

describe("OfflineBanner", () => {
  beforeEach(() => {
    useNetworkStore.setState({ isOnline: true, pendingSyncCount: 0, syncAttentionCount: 0 });
  });

  it("renders nothing when online and no pending items", () => {
    const { container } = render(<OfflineBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("shows red offline banner when isOnline is false", () => {
    useNetworkStore.setState({ isOnline: false, pendingSyncCount: 0 });
    render(<OfflineBanner />);
    expect(screen.getByText(/Offline/i)).toBeInTheDocument();
  });

  it("shows pending count when offline with queued items", () => {
    useNetworkStore.setState({ isOnline: false, pendingSyncCount: 3 });
    render(<OfflineBanner />);
    expect(screen.getByText(/3 transactions awaiting sync/i)).toBeInTheDocument();
  });

  it("shows syncing banner when online with pending items", () => {
    useNetworkStore.setState({ isOnline: true, pendingSyncCount: 2 });
    render(<OfflineBanner />);
    expect(screen.getByText(/Syncing/i)).toBeInTheDocument();
    expect(screen.getByText(/View details/i)).toBeInTheDocument();
  });

  it("shows an attention state instead of claiming blocked transactions are syncing", () => {
    useNetworkStore.setState({
      isOnline: true,
      pendingSyncCount: 2,
      syncAttentionCount: 1,
    });
    render(<OfflineBanner />);

    expect(screen.getByText(/1 transaction needs attention/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Syncing/i)).not.toBeInTheDocument();
  });
});
