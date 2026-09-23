import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoidSaleDialog } from "./VoidSaleDialog";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  voidSale: vi.fn(),
  getSession: vi.fn(),
  invalidateQueries: vi.fn(),
  sessionId: "40000000-0000-0000-0000-000000000001" as string | null,
}));

vi.mock("@/hooks/useTenantContext", () => ({
  useTenantContext: () => ({
    tenantId: "10000000-0000-0000-0000-000000000001",
    branchId: "20000000-0000-0000-0000-000000000001",
  }),
}));

vi.mock("@/hooks/useOpenSession", () => ({
  useOpenSession: () => ({ data: state.sessionId ? { id: state.sessionId } : null }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: state.rpc, auth: { getSession: state.getSession } },
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
    state.getSession.mockResolvedValue({ data: { session: { access_token: "operator-token" } }, error: null });
    state.voidSale.mockResolvedValue("a0000000-0000-0000-0000-000000000001");
    window.electron = { voidSale: state.voidSale } as any;
  });

  it("routes the original-session void through native credential custody", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Void reason"), { target: { value: "Duplicate transaction" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm void" }));

    await waitFor(() => expect(state.voidSale).toHaveBeenCalledTimes(1));
    const [payload, authorization] = state.voidSale.mock.calls[0];
    expect(payload).toMatchObject({
      _tenant_id: "10000000-0000-0000-0000-000000000001",
      _branch_id: "20000000-0000-0000-0000-000000000001",
      _sale_id: sale.id,
      _cash_session_id: sale.session_id,
      _reason: "Duplicate transaction",
    });
    expect(typeof payload._client_mutation_id).toBe("string");
    expect(payload._client_mutation_id.length).toBeGreaterThanOrEqual(8);
    expect(payload).not.toHaveProperty("status");
    expect(authorization).toEqual({
      accessToken: "operator-token",
      tenantId: "10000000-0000-0000-0000-000000000001",
      branchId: "20000000-0000-0000-0000-000000000001",
    });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("reuses the same operation ID after an uncertain RPC failure", async () => {
    state.voidSale
      .mockRejectedValueOnce(new Error("network response lost"))
      .mockResolvedValueOnce("a0000000-0000-0000-0000-000000000001");

    renderDialog();
    const button = screen.getByRole("button", { name: "Confirm void" });
    fireEvent.click(button);
    await waitFor(() => expect(state.voidSale).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    await waitFor(() => expect(state.voidSale).toHaveBeenCalledTimes(2));

    expect(state.voidSale.mock.calls[1][0]._client_mutation_id)
      .toBe(state.voidSale.mock.calls[0][0]._client_mutation_id);
  });

  it("blocks an in-person void when the original sale session is not the current open session", () => {
    state.sessionId = "40000000-0000-0000-0000-000000000099";
    renderDialog();

    expect(screen.getByText(/original cash session is no longer open/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm void" })).toBeDisabled();
  });
});
