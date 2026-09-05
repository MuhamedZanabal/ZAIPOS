import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReturnDialog } from "./ReturnDialog";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@/hooks/useTenantContext", () => ({
  useTenantContext: () => ({
    tenantId: "10000000-0000-0000-0000-000000000001",
    branchId: "20000000-0000-0000-0000-000000000001",
  }),
}));

vi.mock("@/hooks/useOpenSession", () => ({
  useOpenSession: () => ({
    data: { id: "40000000-0000-0000-0000-000000000001" },
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: state.rpc,
    storage: {
      from: () => ({
        upload: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    },
  },
}));

const sale = {
  id: "60000000-0000-0000-0000-000000000001",
  ticket_number: 73,
  total: 10.25,
  status: "completed",
  created_at: "2026-09-05T09:00:00Z",
  sale_items: [
    {
      id: "70000000-0000-0000-0000-000000000001",
      product_id: "50000000-0000-0000-0000-000000000001",
      product_name: "Bahrain Test Product",
      quantity: 2,
      unit_price: 3,
      line_total: 6,
    },
  ],
};

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries").mockImplementation(state.invalidateQueries as any);
  render(
    <QueryClientProvider client={client}>
      <ReturnDialog open onOpenChange={vi.fn()} sale={sale} />
    </QueryClientProvider>,
  );
  return invalidateSpy;
}

describe("ReturnDialog v2 lifecycle wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rpc.mockResolvedValue({ data: "90000000-0000-0000-0000-000000000001", error: null });
  });

  it("does not expose the removed supervisor PIN path", () => {
    renderDialog();
    expect(screen.queryByText(/PIN supervisor/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Required depending on amount/i)).not.toBeInTheDocument();
  });

  it("submits the selected sale items through process_sale_return_v2 with the open cash session", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Process return/i }));

    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(1));

    const [rpcName, payload] = state.rpc.mock.calls[0];
    expect(rpcName).toBe("process_sale_return_v2");
    expect(payload).toMatchObject({
      _sale_id: sale.id,
      _items: [{ sale_item_id: sale.sale_items[0].id, quantity: 2 }],
      _reason_code: "customer_request",
      _cash_session_id: "40000000-0000-0000-0000-000000000001",
      _reason: null,
      _evidence_url: null,
    });
    expect(typeof payload._client_mutation_id).toBe("string");
    expect(payload._client_mutation_id.length).toBeGreaterThanOrEqual(8);
    expect(payload).not.toHaveProperty("_supervisor_pin");
    expect(payload).not.toHaveProperty("_refund_method");
  });
});
