import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: state.rpc },
}));

import { setProductBaseFinancials, setProductSellingPrice } from "./productFinancialCommands";

describe("product financial commands", () => {
  beforeEach(() => {
    state.rpc.mockReset();
    state.rpc.mockResolvedValue({ data: "product-1", error: null });
  });

  it("sends exact integer fils to the base-financial command", async () => {
    await setProductBaseFinancials({
      tenantId: "tenant-1",
      productId: "product-1",
      sellingPriceBhd: "1.250",
      costBhd: "0.750",
      reason: "Supplier review",
      operationId: "product-financial-operation-1",
    });

    expect(state.rpc).toHaveBeenCalledOnce();
    expect(state.rpc).toHaveBeenCalledWith("set_product_base_financials_v1", {
      _tenant_id: "tenant-1",
      _product_id: "product-1",
      _selling_amount_fils: 1250,
      _cost_amount_fils: 750,
      _reason: "Supplier review",
      _operation_id: "product-financial-operation-1",
    });
  });

  it("uses the ledger command for channel overrides and removal", async () => {
    await setProductSellingPrice({
      tenantId: "tenant-1",
      productId: "product-1",
      branchId: "branch-1",
      channel: "talabat",
      amountBhd: "1.775",
      reason: "Channel fee review",
      operationId: "channel-financial-operation-1",
    });
    await setProductSellingPrice({
      tenantId: "tenant-1",
      productId: "product-1",
      branchId: "branch-1",
      channel: "talabat",
      amountBhd: null,
      reason: "Remove channel override",
      operationId: "channel-financial-operation-2",
    });

    expect(state.rpc).toHaveBeenNthCalledWith(1, "set_product_selling_price_v1", expect.objectContaining({
      _amount_fils: 1775,
    }));
    expect(state.rpc).toHaveBeenNthCalledWith(2, "set_product_selling_price_v1", expect.objectContaining({
      _amount_fils: null,
    }));
  });

  it("rejects sub-fils input before calling the server", async () => {
    await expect(setProductBaseFinancials({
      tenantId: "tenant-1",
      productId: "product-1",
      sellingPriceBhd: "1.0004",
      costBhd: "0.750",
      reason: "Invalid precision",
      operationId: "product-financial-operation-3",
    })).rejects.toThrow(/three decimal places/i);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
