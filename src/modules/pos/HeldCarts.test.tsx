import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HoldCartDialog, HeldCartsDialog } from "./HeldCarts";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  invalidateQueries: vi.fn(),
}));

const line: any = {
  id: "water",
  product: {
    id: "50000000-0000-0000-0000-000000000081",
    tenant_id: "10000000-0000-0000-0000-000000000081",
    name: "Water",
    price: 1.25,
    tax_rate: 10,
    product_type: "simple",
    status: "active",
  },
  quantity: 2,
  discount: 0,
};

const preview = {
  cart: { id: "held-1", label: "Lunch order", channel: "pos", customer_id: null, table_id: null },
  items: [{
    line_id: "water",
    product_id: line.product.id,
    product_name: "Water",
    product_type: "simple",
    quantity: 2,
    expected_unit_price_fils: 1250,
    current_unit_price_fils: 1500,
    discount_fils: 0,
    available_quantity: 1,
    modifiers: [],
    issues: ["price_changed", "insufficient_stock"],
  }],
};

const resumed = {
  cart: preview.cart,
  items: [{
    ...preview.items[0],
    quantity: 1,
    issues: [],
    product: {
      id: line.product.id,
      tenant_id: line.product.tenant_id,
      name: "Water",
      price_fils: 1500,
      tax_rate: 10,
      product_type: "simple",
      status: "active",
    },
  }],
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: [{ id: "held-1", label: "Lunch order", item_count: 1, total_fils: 2500, channel: "pos", created_at: "2026-09-08T12:00:00Z", created_by_name: "Zana" }],
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: state.invalidateQueries }),
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: state.rpc } }));

describe("held cart POS controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "hold_cart_v1") return { data: "held-1", error: null };
      if (name === "preview_held_cart_resume_v1") return { data: preview, error: null };
      if (name === "resume_held_cart_v1") return { data: resumed, error: null };
      if (name === "discard_held_cart_v1") return { data: "held-1", error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
  });

  it("holds the current branch cart with exact snapshot context", async () => {
    const onHeld = vi.fn();
    render(
      <HoldCartDialog
        open
        onOpenChange={vi.fn()}
        branchId="20000000-0000-0000-0000-000000000081"
        channel="pos"
        customerId={null}
        tableId={null}
        lines={[line]}
        onHeld={onHeld}
      />,
    );

    fireEvent.change(screen.getByLabelText("Cart label"), { target: { value: "Lunch order" } });
    fireEvent.click(screen.getByRole("button", { name: "Hold cart" }));

    await waitFor(() => expect(onHeld).toHaveBeenCalledTimes(1));
    expect(state.rpc).toHaveBeenCalledWith("hold_cart_v1", expect.objectContaining({
      _branch_id: "20000000-0000-0000-0000-000000000081",
      _label: "Lunch order",
      _channel: "pos",
      _items: [expect.objectContaining({ expected_unit_price_fils: 1250 })],
      _client_operation_id: expect.any(String),
    }));
  });

  it("blocks resume until changed price and insufficient stock are explicitly resolved", async () => {
    const onResumed = vi.fn();
    render(
      <HeldCartsDialog
        open
        onOpenChange={vi.fn()}
        branchId="20000000-0000-0000-0000-000000000081"
        onResumed={onResumed}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review held cart Lunch order" }));
    await screen.findByText("Price changed");
    expect(screen.getByRole("button", { name: "Resume cart" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Accept BHD 1.500" }));
    fireEvent.click(screen.getByRole("button", { name: "Reduce to 1" }));
    expect(screen.getByRole("button", { name: "Resume cart" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Resume cart" }));

    await waitFor(() => expect(onResumed).toHaveBeenCalledTimes(1));
    expect(state.rpc).toHaveBeenLastCalledWith("resume_held_cart_v1", {
      _held_cart_id: "held-1",
      _resolutions: [{ line_id: "water", accept_current_price: true, quantity: 1, remove: false }],
      _client_operation_id: expect.any(String),
    });
    expect(onResumed.mock.calls[0][0]).toEqual(expect.objectContaining({
      channel: "pos",
      lines: [expect.objectContaining({ quantity: 1, product: expect.objectContaining({ name: "Water", price: 1.5 }) })],
    }));
  });
});
