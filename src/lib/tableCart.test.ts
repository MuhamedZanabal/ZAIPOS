import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));

import { appendTableCart } from "./tableCart";

describe("authoritative table-cart client", () => {
  beforeEach(() => {
    mocks.rpc.mockReset().mockResolvedValue({ data: "fa000000-0000-0000-0000-000000000201", error: null });
    sessionStorage.clear();
  });

  it("submits identities and quantities without renderer financial fields", async () => {
    await appendTableCart({
      tenantId: "tenant", branchId: "branch", tableId: "table", operationId: "table-cart:fixed",
      items: [{ product_id: "product", quantity: 1.25, modifier_option_ids: ["z", "a", "a"], notes: " no onion " }],
    });
    expect(mocks.rpc).toHaveBeenCalledWith("append_table_cart_v2", {
      _tenant_id: "tenant", _branch_id: "branch", _table_id: "table", _operation_id: "table-cart:fixed",
      _items: [{ product_id: "product", quantity: 1.25, modifier_option_ids: ["a", "z"], notes: "no onion" }],
    });
    expect(JSON.stringify(mocks.rpc.mock.calls[0][1])).not.toMatch(/unit_price|tax_rate|line_total|discount|product_name/);
  });

  it("reuses its persisted identity after an indeterminate response", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error("Failed to fetch") })
      .mockResolvedValueOnce({ data: "fa000000-0000-0000-0000-000000000202", error: null });
    const command = { tenantId:"t",branchId:"b",tableId:"x",items:[{product_id:"p",quantity:1,modifier_option_ids:[],notes:null}] };
    await expect(appendTableCart(command)).rejects.toThrow("Failed to fetch");
    await expect(appendTableCart(command)).resolves.toMatchObject({ orderId:"fa000000-0000-0000-0000-000000000202" });
    expect(mocks.rpc.mock.calls[1][1]._operation_id).toBe(mocks.rpc.mock.calls[0][1]._operation_id);
    expect(sessionStorage.length).toBe(0);
  });
});
