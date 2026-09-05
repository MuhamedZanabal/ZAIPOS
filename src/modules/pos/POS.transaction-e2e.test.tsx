import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentAllocation } from "./paymentAllocations";

const state = vi.hoisted(() => ({
  allocation: { method: "cash", amountFils: 1000, tenderedFils: 1000, changeFils: 0, reference: null } as PaymentAllocation,
  barcodeHandler: null as null | ((code: string) => void),
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
      "pos-tenant": { name: "ZAIPOS E2E", receipt_config: {} },
      "pos-stocks": [{ product_id: "50000000-0000-0000-0000-000000000077", quantity: 3 }],
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
    tenantId: "10000000-0000-0000-0000-000000000077",
    branchId: "20000000-0000-0000-0000-000000000077",
    branches: [{ id: "20000000-0000-0000-0000-000000000077", name: "Amwaj Test" }],
    activeChannels: ["pos"],
  }),
}));

vi.mock("@/hooks/useOpenSession", () => ({
  useOpenSession: () => ({ data: { id: "40000000-0000-0000-0000-000000000077" } }),
}));

vi.mock("@/hooks/useDevMode", () => ({ useDevMode: () => ({ devMode: false }) }));
vi.mock("@/hooks/useProducts", () => ({
  useProducts: () => ({
    data: [{
      id: "50000000-0000-0000-0000-000000000077",
      tenant_id: "10000000-0000-0000-0000-000000000077",
      name: "Scanned Water",
      barcode: "6290000000777",
      sku: "WATER-077",
      price: 1,
      cost: 0.5,
      tax_rate: 0,
      product_type: "simple",
      category_id: null,
      status: "active",
      unit_code: "unit",
      min_stock: 0,
      image_url: null,
      color: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    }],
  }),
}));

vi.mock("@/hooks/useHardware", () => ({
  useHardware: () => ({
    onBarcodeScanned: (handler: (code: string) => void) => {
      state.barcodeHandler = handler;
      return () => { if (state.barcodeHandler === handler) state.barcodeHandler = null; };
    },
    printTicket: state.printTicket,
    openDrawer: state.openDrawer,
  }),
}));

vi.mock("@/hooks/useOfflineMutation", () => ({
  useOfflineMutation: (config: { type: string; mutationFn?: (payload: unknown) => Promise<unknown> }) => ({
    mutateAsync: async (payload: unknown) => {
      if (config.type !== "CHECKOUT_SALE_V2") throw new Error(`Unexpected transaction type: ${config.type}`);
      if (!config.mutationFn) throw new Error("Missing checkout mutation function");
      return config.mutationFn(payload);
    },
  }),
}));

vi.mock("@/integrations/supabase/client", () => {
  const sale = {
    ticket_number: 77,
    subtotal: 1,
    tax_total: 0,
    total: 1,
    discount_total: 0,
    tip_amount: 0,
  };

  function tableQuery(table: string) {
    if (table === "sales") {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: sale, error: null }),
      };
      return query;
    }
    if (table === "modifier_groups") {
      const query = {
        select: () => query,
        eq: () => query,
        order: async () => ({ data: [], error: null }),
      };
      return query;
    }
    if (table === "product_complementaries") {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: async () => ({ data: [], error: null }),
      };
      return query;
    }
    throw new Error(`Unexpected Supabase table in POS E2E: ${table}`);
  }

  return {
    supabase: {
      auth: { getUser: vi.fn() },
      from: vi.fn(tableQuery),
      rpc: state.rpc,
    },
  };
});

vi.mock("./CategoryBar", () => ({ CategoryBar: () => null }));
vi.mock("./ProductGrid", () => ({ ProductGrid: () => null }));
vi.mock("./TicketPanel", () => ({ TicketPanel: () => null }));
vi.mock("@/components/shared/ModifierSelector", () => ({ ModifierSelector: () => null, validateModifiers: () => null }));
vi.mock("@/components/shared/BrandBar", () => ({ BrandBar: () => null }));
vi.mock("@/components/shared/TickRail", () => ({ TickRail: () => null }));
vi.mock("@/components/shared/LiveDot", () => ({ LiveDot: () => null }));
vi.mock("./PaymentDialog", () => ({
  PaymentDialog: ({ onConfirm }: { onConfirm: (allocations: PaymentAllocation[], tip: number) => void }) => (
    <button type="button" onClick={() => onConfirm([state.allocation], 0)}>Pay scanned ticket</button>
  ),
}));

import POS from "./POS";
import { useCart } from "@/stores/cart";

async function scanAndPay() {
  render(<POS />);
  await waitFor(() => expect(state.barcodeHandler).toBeTypeOf("function"));
  await act(async () => {
    state.barcodeHandler?.("6290000000777");
  });
  await waitFor(() => expect(useCart.getState().lines).toHaveLength(1));
  expect(useCart.getState().lines[0].product.name).toBe("Scanned Water");
  fireEvent.click(screen.getByRole("button", { name: "Pay scanned ticket" }));
}

describe("POS scan → pay → commit → receipt → stock refresh", () => {
  beforeEach(() => {
    useCart.getState().clear();
    vi.clearAllMocks();
    state.barcodeHandler = null;
    state.printTicket.mockResolvedValue({ ok: true });
    state.openDrawer.mockResolvedValue({ ok: true });
    state.rpc.mockImplementation(async (name: string) => {
      if (name !== "checkout_sale_v2") throw new Error(`Unexpected RPC: ${name}`);
      return { data: "60000000-0000-0000-0000-000000000077", error: null };
    });
  });

  it("scans into the real cart, commits once, prints once, opens cash drawer, clears cart, and refreshes stock", async () => {
    await scanAndPay();

    await waitFor(() => expect(state.printTicket).toHaveBeenCalledTimes(1));
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.openDrawer).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useCart.getState().lines).toHaveLength(0));
    expect(state.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["pos-stocks"] });
    expect(state.printTicket).toHaveBeenCalledWith(expect.objectContaining({
      ticketNumber: 77,
      items: [expect.objectContaining({ name: "Scanned Water", quantity: 1, total: 1 })],
      payments: [{ method: "cash", amount: 1 }],
      total: 1,
    }));
  });

  it("does not retry or invalidate a committed sale when printing fails", async () => {
    state.printTicket.mockRejectedValueOnce(new Error("printer offline"));
    await scanAndPay();

    await waitFor(() => expect(useCart.getState().lines).toHaveLength(0));
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.printTicket).toHaveBeenCalledTimes(1);
    expect(state.openDrawer).not.toHaveBeenCalled();
    expect(state.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["pos-stocks"] });
  });

  it("does not retry or invalidate a committed sale when the cash drawer fails", async () => {
    state.openDrawer.mockRejectedValueOnce(new Error("drawer jammed"));
    await scanAndPay();

    await waitFor(() => expect(useCart.getState().lines).toHaveLength(0));
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.printTicket).toHaveBeenCalledTimes(1);
    expect(state.openDrawer).toHaveBeenCalledTimes(1);
    expect(state.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["pos-stocks"] });
  });
});
