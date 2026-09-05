import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoidSaleDialog } from "./VoidSaleDialog";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  invalidateQueries: vi.fn(),
  sessionId: "40000000-0000-0000-0000-000000000001" as string | null,
}));

vi.mock("@/hooks/useTenantContext", () => ({
  useTenantContext: () => ({ branchId: "20000000-0000-0000-0000-000000000001" }),
}));

vi.mock("@/hooks/useOpenSession", () => ({
  useOpenSession: () => ({ data: state.sessionId ? { id: state.sessionId } : null }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: state.rpc },
}));

const sale = {
  id: "60000000-0000-0000-0000-000000000001",
  ticket_number: 73,
  total: 10.25,
  total_fils: 10250,
  status: "completed",
  channel: "pos",
  session_id: "40000000-0000-0000-0000-000000000001",
};

function renderDialog(overrides: Partial<typeof sale> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.spyOn(client, "invalidateQueries").mockImplementation(state.invalidateQueries as any);
  render(
    <QueryClientProvider client={client}>
      <VoidSaleDialog open onOpenChange={vi.fn()} sale={{ ...sale, ...overrides }} />
    </QueryClientProvider>,
  );
}

describe("VoidSaleDialog v2 lifecycle wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.sessionId = sale.session_id;
    state.rpc.mockResolvedValue({ data: "a0000000-0000-0000-0000-000000000001", error: null });
  });

  it("calls only process_sale_void_v2 with the original open session", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Void reason"), { target: { value: "Duplicate transaction" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm void" }));

    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(1));
    const [rpcName, payload] = state.rpc.mock.calls[0];
    expect(rpcName).toBe("process_sale_void_v2");
    expect(payload).toMatchObject({
      _sale_id: sale.id,
      _cash_session_id: sale.session_id,
      _reason: "Duplicate transaction",
    });
    expect(typeof payload._client_mutation_id).toBe("string");
    expect(payload._client_mutation_id.length).toBeGreaterThanOrEqual(8);
    expect(payload).not.toHaveProperty("status");
  });

  it("reuses the same operation ID after an uncertain RPC failure", async () => {
    state.rpc
      .mockResolvedValueOnce({ data: null, error: new Error("network response lost") })
      .mockResolvedValueOnce({ data: "a0000000-0000-0000-0000-000000000001", error: null });

    renderDialog();
    const button = screen.getByRole("button", { name: "Confirm void" });
    fireEvent.click(button);
    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(2));

    expect(state.rpc.mock.calls[1][1]._client_mutation_id)
      .toBe(state.rpc.mock.calls[0][1]._client_mutation_id);
  });

  it("blocks an in-person void when the original sale session is not the current open session", () => {
    state.sessionId = "40000000-0000-0000-0000-000000000099";
    renderDialog();

    expect(screen.getByText(/original cash session is no longer open/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm void" })).toBeDisabled();
  });
});
