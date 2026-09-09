import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PriceOverrideDialog, PriceOverrideApprovalsDialog } from "./PriceOverride";

const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: state.rpc } }));

const line: any = {
  id: "water",
  product: {
    id: "50000000-0000-0000-0000-000000000091",
    name: "Water",
    price: 1.25,
    tax_rate: 0,
    product_type: "simple",
    _modifiers: [],
  },
  quantity: 1,
  discount: 0,
};

describe("POS price override controls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requests an exact-fils override with stable operation evidence", async () => {
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "request_price_override_v1") return { data: "override-1", error: null };
      if (name === "get_price_override_request_v1") return { data: { id: "override-1", status: "pending" }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });

    render(<PriceOverrideDialog open onOpenChange={vi.fn()} tenantId="tenant-a" branchId="branch-a" channel="pos" line={line} onApproved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Override price"), { target: { value: "1.000" } });
    fireEvent.change(screen.getByLabelText("Override reason"), { target: { value: "Customer price match" } });
    fireEvent.click(screen.getByRole("button", { name: "Request manager approval" }));

    await screen.findByText("Waiting for manager approval");
    expect(state.rpc).toHaveBeenCalledWith("request_price_override_v1", expect.objectContaining({
      _tenant_id: "tenant-a",
      _branch_id: "branch-a",
      _product_id: line.product.id,
      _requested_unit_price_fils: 1000,
      _client_mutation_id: expect.any(String),
    }));
  });

  it("applies only server-approved evidence to the selected line", async () => {
    const onApproved = vi.fn();
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "request_price_override_v1") return { data: "override-1", error: null };
      if (name === "get_price_override_request_v1") return {
        data: {
          id: "override-1", status: "approved", quantity: 1,
          original_unit_price_fils: 1250, requested_unit_price_fils: 1000,
          request_reason: "Customer price match", approved_by: "manager-1", approved_at: "2026-09-09T00:00:00Z",
        }, error: null,
      };
      throw new Error(`Unexpected RPC: ${name}`);
    });
    render(<PriceOverrideDialog open onOpenChange={vi.fn()} tenantId="tenant-a" branchId="branch-a" channel="pos" line={line} onApproved={onApproved} />);
    fireEvent.change(screen.getByLabelText("Override price"), { target: { value: "1.000" } });
    fireEvent.change(screen.getByLabelText("Override reason"), { target: { value: "Customer price match" } });
    fireEvent.click(screen.getByRole("button", { name: "Request manager approval" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply approved price" }));
    expect(onApproved).toHaveBeenCalledWith(expect.objectContaining({ requestId: "override-1", overrideUnitPriceFils: 1000, approvedBy: "manager-1" }));
  });

  it("lets an authorized manager approve a pending branch request", async () => {
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "list_pending_price_overrides_v1") return { data: [{ id: "override-1", product_name: "Water", original_unit_price_fils: 1250, requested_unit_price_fils: 1000, request_reason: "Customer price match", requested_by: "cashier-1", created_at: "2026-09-09T00:00:00Z" }], error: null };
      if (name === "decide_price_override_v1") return { data: "override-1", error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
    render(<PriceOverrideApprovalsDialog open onOpenChange={vi.fn()} branchId="branch-a" />);
    await screen.findByText("Customer price match");
    fireEvent.click(screen.getByRole("button", { name: "Approve Water override" }));
    await waitFor(() => expect(state.rpc).toHaveBeenCalledWith("decide_price_override_v1", expect.objectContaining({ _request_id: "override-1", _approve: true })));
  });

  it("shows a retryable manager-list error", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "connection unavailable" } });
    render(<PriceOverrideApprovalsDialog open onOpenChange={vi.fn()} branchId="branch-a" />);
    await screen.findByText("Approval requests could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Retry price override approvals" }));
    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(2));
  });
});
