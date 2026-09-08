import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  printTicket: vi.fn(),
  rpc: vi.fn(),
}));

const sale = {
  id: "60000000-0000-0000-0000-000000000073",
  ticket_number: 73,
  total: 2.5,
  total_fils: 2500,
  tip_amount_fils: 25,
  status: "completed",
  channel: "pos",
  session_id: "40000000-0000-0000-0000-000000000073",
  customer_id: null,
  created_at: "2026-09-05T09:00:00Z",
  sale_items: [],
  payments: [{ method: "cash", amount: 2.5 }],
};

const prepared = {
  event_id: "90000000-0000-0000-0000-000000000073",
  current_status: "completed",
  snapshot: {
    ticket_number: 73,
    transaction_time: "2026-09-05T09:00:00Z",
    business: { name: "Amwaj Al Dair", receipt_config: {} },
    branch: { name: "Muharraq", address: null, phone: null },
    cashier: { id: "30000000-0000-0000-0000-000000000073", name: "Zana" },
    customer: null,
    totals: { subtotal_fils: 2500, discount_total_fils: 0, tax_total_fils: 0, tip_amount_fils: 0, total_fils: 2500 },
    items: [{ id: "70000000-0000-0000-0000-000000000073", name: "Stored name", quantity: 2, unit_price_fils: 1250, discount_fils: 0, line_total_fils: 2500, tax_rate: 0 }],
    payments: [{ id: "71000000-0000-0000-0000-000000000073", method: "cash", amount_fils: 2500, reference: null }],
  },
};

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [sale] }) }));
vi.mock("@/hooks/useTenantContext", () => ({ useTenantContext: () => ({ branchId: "20000000-0000-0000-0000-000000000073" }) }));
vi.mock("@/hooks/useHardware", () => ({ useHardware: () => ({ printTicket: state.printTicket }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => {
      const query: any = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: [sale] }) };
      return query;
    }),
    rpc: state.rpc,
  },
}));
vi.mock("./ReturnDialog", () => ({ ReturnDialog: () => null }));
vi.mock("./VoidSaleDialog", () => ({ VoidSaleDialog: () => null }));

import Sales from "./Sales";

describe("Sales historical receipt reprint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.printTicket.mockResolvedValue({ ok: true });
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "prepare_sale_receipt_reprint_v1") return { data: prepared, error: null };
      if (name === "complete_sale_receipt_reprint_v1") return { data: prepared.event_id, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
  });

  it("prepares, prints and records one reprint without rebuilding from current products", async () => {
    render(<Sales />);
    fireEvent.click(screen.getByRole("button", { name: "Reprint receipt #73" }));

    await waitFor(() => expect(state.printTicket).toHaveBeenCalledTimes(1));
    expect(state.rpc.mock.calls[0][0]).toBe("prepare_sale_receipt_reprint_v1");
    expect(state.rpc.mock.calls[0][1]._sale_id).toBe(sale.id);
    expect(state.rpc.mock.calls[0][1]._client_operation_id).toEqual(expect.any(String));
    expect(state.printTicket).toHaveBeenCalledWith(expect.objectContaining({
      isReprint: true,
      ticketNumber: 73,
      items: [expect.objectContaining({ name: "Stored name", unitPrice: 1.25 })],
    }));
    expect(state.rpc.mock.calls[1]).toEqual([
      "complete_sale_receipt_reprint_v1",
      { _event_id: prepared.event_id, _outcome: "printed", _failure_code: null },
    ]);
  });

  it("records printer failure separately and never prepares or prints twice", async () => {
    state.printTicket.mockResolvedValue({ ok: false, error: "printer offline" });
    render(<Sales />);
    fireEvent.click(screen.getByRole("button", { name: "Reprint receipt #73" }));

    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(2));
    expect(state.printTicket).toHaveBeenCalledTimes(1);
    expect(state.rpc.mock.calls[1]).toEqual([
      "complete_sale_receipt_reprint_v1",
      { _event_id: prepared.event_id, _outcome: "failed", _failure_code: "printer_failed" },
    ]);
  });
});
