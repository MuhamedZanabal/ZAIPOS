import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));

import {
  createTableOrderLifecyclePayload,
  createTableOrderTransitionPayload,
  transitionTableItem,
  transitionTableOrder,
  transitionTableOrderLifecycle,
} from "./tableKitchen";

describe("scoped table kitchen transitions", () => {
  beforeEach(() => { mocks.rpc.mockReset(); sessionStorage.clear(); });

  it("submits item transitions with complete scope and stable identity", async () => {
    mocks.rpc.mockResolvedValue({ data: { id: "item" }, error: null });
    await transitionTableItem({ tenantId:"t",branchId:"b",itemId:"i",action:"dispatch",operationId:"fixed-operation" });
    expect(mocks.rpc).toHaveBeenCalledWith("transition_table_item_v2", {
      _tenant_id:"t",_branch_id:"b",_item_id:"i",_operation_id:"fixed-operation",_action:"dispatch",
    });
  });

  it("reuses item identity after an indeterminate response", async () => {
    mocks.rpc.mockResolvedValueOnce({ data:null,error:new Error("Failed to fetch") })
      .mockResolvedValueOnce({ data:{ id:"i" },error:null });
    const args = { tenantId:"t",branchId:"b",itemId:"i",action:"mark_ready" as const };
    await expect(transitionTableItem(args)).rejects.toThrow("Failed to fetch");
    await transitionTableItem(args);
    expect(mocks.rpc.mock.calls[1][1]._operation_id).toBe(mocks.rpc.mock.calls[0][1]._operation_id);
  });

  it("preserves the bulk transition identity used by offline replay", async () => {
    mocks.rpc.mockResolvedValue({ data:2,error:null });
    const payload = createTableOrderTransitionPayload({ tenantId:"t",branchId:"b",orderId:"o",action:"send_to_kitchen",operationId:"queue-id" });
    await expect(transitionTableOrder(payload)).resolves.toBe(2);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({_operation_id:"queue-id",_tenant_id:"t",_branch_id:"b"});
  });

  it("persists lifecycle identity before submit and reuses it after response loss", async () => {
    mocks.rpc.mockResolvedValueOnce({ data:null,error:new Error("Failed to fetch") })
      .mockResolvedValueOnce({ data:{ id:"o",status:"sent_to_cashier" },error:null });
    const first = createTableOrderLifecyclePayload({ tenantId:"t",branchId:"b",orderId:"o",action:"send_to_cashier" });
    await expect(transitionTableOrderLifecycle(first)).rejects.toThrow("Failed to fetch");
    const replay = createTableOrderLifecyclePayload({ tenantId:"t",branchId:"b",orderId:"o",action:"send_to_cashier" });
    expect(replay._client_mutation_id).toBe(first._client_mutation_id);
    await expect(transitionTableOrderLifecycle(replay)).resolves.toMatchObject({ id:"o",status:"sent_to_cashier" });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2,"transition_table_order_lifecycle_v2",{
      _tenant_id:"t",_branch_id:"b",_order_id:"o",_operation_id:first._client_mutation_id,_action:"send_to_cashier",
    });
  });
});
