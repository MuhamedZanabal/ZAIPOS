import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));

import { mutateTableOrderItem } from "./tableOrderItems";

describe("atomic table-order item client", () => {
  beforeEach(() => {
    mocks.rpc.mockReset().mockResolvedValue({ data: "fa000000-0000-0000-0000-000000000101", error: null });
    sessionStorage.clear();
  });

  it("submits one scoped command and returns its immutable receipt", async () => {
    const result = await mutateTableOrderItem({
      tenantId: "tenant", branchId: "branch", orderId: "order", action: "add",
      productId: "product", quantity: 1, notes: " no onion ", operationId: "table-item:fixed-operation",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("mutate_table_order_item_v2", {
      _tenant_id: "tenant", _branch_id: "branch", _order_id: "order",
      _operation_id: "table-item:fixed-operation", _action: "add", _item_id: null,
      _product_id: "product", _quantity: 1, _notes: "no onion",
    });
    expect(result).toEqual({ itemId: "fa000000-0000-0000-0000-000000000101", operationId: "table-item:fixed-operation" });
  });

  it("fails closed on server errors or malformed receipts", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error("Forbidden") });
    await expect(mutateTableOrderItem({ tenantId:"t",branchId:"b",orderId:"o",action:"delete",itemId:"i" }))
      .rejects.toThrow("Forbidden");
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(mutateTableOrderItem({ tenantId:"t",branchId:"b",orderId:"o",action:"delete",itemId:"i" }))
      .rejects.toThrow(/invalid receipt/i);
  });

  it("reuses the persisted identity after an indeterminate response", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: new Error("Failed to fetch") })
      .mockResolvedValueOnce({ data: "fa000000-0000-0000-0000-000000000102", error: null });
    const command = { tenantId:"t",branchId:"b",orderId:"o",action:"add" as const,productId:"p",quantity:1 };
    await expect(mutateTableOrderItem(command)).rejects.toThrow("Failed to fetch");
    await expect(mutateTableOrderItem(command)).resolves.toMatchObject({ itemId:"fa000000-0000-0000-0000-000000000102" });
    expect(mocks.rpc.mock.calls[1][1]._operation_id).toBe(mocks.rpc.mock.calls[0][1]._operation_id);
    expect(sessionStorage.length).toBe(0);
  });
});
