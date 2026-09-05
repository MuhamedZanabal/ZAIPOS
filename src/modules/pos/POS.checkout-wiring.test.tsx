import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentAllocation } from "./paymentAllocations";

const state = vi.hoisted(() => ({
  allocations: [] as PaymentAllocation[],
  clear: vi.fn(),
  invalidateQueries: vi.fn(),
  openDrawer: vi.fn().mockResolvedValue({ ok: true }),
  printTicket: vi.fn().mockResolvedValue({ ok: true }),
  rpc: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: [string] }) => {
    const fixtures: Record<string, unknown> = {
      "pos-today-metrics": { count: 0, totalSales: 0, avgTicket: 0 },
      "pos-categories": [],
      "pos-tenant": { name: "ZAIPOS Test", receipt_config: {} },
      "pos-stocks": [],
      "pos-branch-products": [],
      "pos-channel-prices": [],
      "customers-pos": [],
      "pos-tables": [],
      "pos-pending-tables": 0,
    };
    return { data: fixtures[queryKey[0]] };
  },
  useQueryClient: () => ({ invalidateQueries: state.invalidateQueries }),
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: ReactNode }) => <>{children}</>,
  useNavigate: () => vi.fn(),
}));

vi.mock("@/hooks/useTenantContext", () => ({
  useTenantContext: () => ({
    tenantId: "10000000-0000-0000-0000-000000000001",
    branchId: "20000000-0000-0000-0000-000000000001",
    branches: [{ id: "20000000-0000-0000-0000-000000000001", name: "Manama" }],
    activeChannels: ["pos"],
  }),
}));

vi.mock("@/hooks/useOpenSession", () => ({
  useOpenSession: () => ({
    data: { id: "40000000-0000-0000-0000-000000000001" },
  }),
}));

vi.mock("@/hooks/useDevMode", () => ({ useDevMode: () => ({ devMode: false }) }));
vi.mock("@/hooks/useProducts", () => ({ useProducts: () => ({ data: [] }) }));

vi.mock("@/stores/cart", () => ({
  useCart: () => ({
    lines: [{
      id: "50000000-0000-0000-0000-000000000001",
      product: {
        id: "50000000-0000-0000-0000-000000000001",
        name: "Bahrain Test Product",
        price: 8.5,
        tax_rate: 0,
        product_type: "simple",
        _modifiers: [],
      },
      quantity: 1,
      discount: 0,
    }],
    total: () => 8.5,
    clear: state.clear,
    add: vi.fn(),
  }),
}));

vi.mock("@/hooks/useHardware", () => ({
  useHardware: () => ({
    onBarcodeScanned: () => () => undefined,
    printTicket: state.printTicket,
    openDrawer: state.openDrawer,
  }),
}));

vi.mock("@/hooks/useOfflineMutation", () => ({
  useOfflineMutation: (config: {
    type: string;
    mutationFn?: (payload: unknown) => Promise<unknown>;
  }) => ({
    mutateAsync: async (payload: unknown) => {
      if (config.type !== "CHECKOUT_SALE_V2") {
        throw new Error(`Unexpected checkout queue type: ${config.type}`);
      }
      if (!config.mutationFn) throw new Error("Missing checkout mutation function");
      return config.mutationFn(payload);
    },
  }),
}));

vi.mock("@/integrations/supabase/client", () => {
  const sale = {
    ticket_number: 73,
    subtotal: 8.5,
    tax_total: 0,
    total: 8.5,
    discount_total: 0,
    tip_amount: 0,
  };
  const saleQuery = {
    select: () => saleQuery,
    eq: () => saleQuery,
    maybeSingle: async () => ({ data: sale, error: null }),
  };
  return {
    supabase: {
      auth: { getUser: vi.fn() },
      from: vi.fn(() => saleQuery),
      rpc: state.rpc,
    },
  };
});

vi.mock("./CategoryBar", () => ({ CategoryBar: () => null }));
vi.mock("./ProductGrid", () => ({ ProductGrid: () => null }));
vi.mock("./TicketPanel", () => ({ TicketPanel: () => null }));
vi.mock("@/components/shared/ModifierSelector", () => ({
  ModifierSelector: () => null,
  validateModifiers: () => null,
}));
vi.mock("@/components/shared/BrandBar", () => ({ BrandBar: () => null }));
vi.mock("@/components/shared/TickRail", () => ({ TickRail: () => null }));
vi.mock("@/components/shared/LiveDot", () => ({ LiveDot: () => null }));

vi.mock("./PaymentDialog", () => ({
  PaymentDialog: ({ onConfirm }: {
    onConfirm: (allocations: PaymentAllocation[], tip: number) => void;
  }) => (
    <button type="button" onClick={() => onConfirm(state.allocations, 0)}>
      Complete mixed sale
    </button>
  ),
}));

import POS from "./POS";

describe("POS native split checkout wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rpc.mockImplementation(async (name: string) => {
      if (name !== "checkout_sale_v2") throw new Error(`Unexpected RPC: ${name}`);
      return { data: "60000000-0000-0000-0000-000000000001", error: null };
    });
  });

  it("commits all payment allocations through checkout_sale_v2 and prints the split receipt", async () => {
    state.allocations = [
      { method: "card", amountFils: 3_500, tenderedFils: 3_500, changeFils: 0, reference: "CARD-1" },
      { method: "cash", amountFils: 5_000, tenderedFils: 10_000, changeFils: 5_000, reference: null },
    ];

    render(<POS />);
    fireEvent.click(screen.getByRole("button", { name: "Complete mixed sale" }));

    await waitFor(() => expect(state.printTicket).toHaveBeenCalledTimes(1));

    expect(state.rpc).toHaveBeenCalledTimes(1);
    const [rpcName, payload] = state.rpc.mock.calls[0];
    expect(rpcName).toBe("checkout_sale_v2");
    expect(payload).toMatchObject({
      _tenant_id: "10000000-0000-0000-0000-000000000001",
      _branch_id: "20000000-0000-0000-0000-000000000001",
      _cash_session_id: "40000000-0000-0000-0000-000000000001",
      _payments: [
        { method: "card", amount_fils: 3_500, reference: "CARD-1" },
        { method: "cash", amount_fils: 5_000, reference: null },
      ],
    });
    expect(payload._items[0]).not.toHaveProperty("unit_price");
    expect(payload._items[0]).not.toHaveProperty("tax_rate");
    expect(state.printTicket).toHaveBeenCalledWith(expect.objectContaining({
      payments: [
        { method: "card", amount: 3.5 },
        { method: "cash", amount: 5 },
      ],
    }));
    expect(state.openDrawer).toHaveBeenCalledTimes(1);
  });

  it("does not open the cash drawer for a fully non-cash split sale", async () => {
    state.allocations = [
      { method: "qr", amountFils: 3_500, tenderedFils: 3_500, changeFils: 0, reference: "BP-1" },
      { method: "card", amountFils: 5_000, tenderedFils: 5_000, changeFils: 0, reference: "CARD-2" },
    ];

    render(<POS />);
    fireEvent.click(screen.getByRole("button", { name: "Complete mixed sale" }));

    await waitFor(() => expect(state.printTicket).toHaveBeenCalledTimes(1));
    expect(state.openDrawer).not.toHaveBeenCalled();
  });
});
