import { supabase } from "@/integrations/supabase/client";

export type TableItemTransition = "start_preparing" | "mark_ready" | "dispatch" | "undispatch";
export type TableOrderTransition = "send_to_kitchen" | "mark_ready";
export type TableOrderLifecycleAction = "send_to_cashier" | "cancel";

const PREFIX = "zaipos:table-kitchen-operation:";

function persistedOperationId(parts: string[], supplied?: string) {
  const key = `${PREFIX}${JSON.stringify(parts)}`;
  const persisted = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(key);
  const operationId = supplied ?? persisted ?? `table-kitchen:${crypto.randomUUID()}`;
  if (!supplied && typeof sessionStorage !== "undefined") sessionStorage.setItem(key, operationId);
  return { key, operationId };
}

function clearForDefinitiveResult(key: string, error?: { message?: string } | null) {
  if (typeof sessionStorage === "undefined") return;
  if (!error || !/fetch|network|connection|timeout/i.test(error.message ?? "")) sessionStorage.removeItem(key);
}

export async function transitionTableItem(args: {
  tenantId: string; branchId: string; itemId: string; action: TableItemTransition; operationId?: string;
}) {
  const pending = persistedOperationId([args.tenantId,args.branchId,args.itemId,args.action],args.operationId);
  const { data, error } = await supabase.rpc("transition_table_item_v2" as any, {
    _tenant_id: args.tenantId, _branch_id: args.branchId, _item_id: args.itemId,
    _operation_id: pending.operationId, _action: args.action,
  });
  clearForDefinitiveResult(pending.key,error);
  if (error) throw error;
  if (!data || typeof data !== "object") throw new Error("Table-item transition returned an invalid receipt");
  return { item: data, operationId: pending.operationId };
}

export function createTableOrderTransitionPayload(args: {
  tenantId: string; branchId: string; orderId: string; action: TableOrderTransition; operationId?: string;
}) {
  return {
    _tenant_id: args.tenantId,
    _branch_id: args.branchId,
    _order_id: args.orderId,
    _action: args.action,
    _client_mutation_id: args.operationId ?? `table-kitchen:${crypto.randomUUID()}`,
  };
}

export async function transitionTableOrder(payload: ReturnType<typeof createTableOrderTransitionPayload>) {
  const { data, error } = await supabase.rpc("transition_table_order_v2" as any, {
    _tenant_id: payload._tenant_id, _branch_id: payload._branch_id, _order_id: payload._order_id,
    _operation_id: payload._client_mutation_id, _action: payload._action,
  });
  if (error) throw error;
  if (typeof data !== "number") throw new Error("Table-order transition returned an invalid receipt");
  return data;
}

export function createTableOrderLifecyclePayload(args: {
  tenantId:string; branchId:string; orderId:string; action:TableOrderLifecycleAction; operationId?:string;
}) {
  const pending = persistedOperationId(
    [args.tenantId,args.branchId,args.orderId,args.action],
    args.operationId,
  );
  return {
    _tenant_id:args.tenantId,_branch_id:args.branchId,_order_id:args.orderId,_action:args.action,
    _client_mutation_id:pending.operationId,
  };
}

export async function transitionTableOrderLifecycle(payload: ReturnType<typeof createTableOrderLifecyclePayload>) {
  const pending=persistedOperationId([
    payload._tenant_id,payload._branch_id,payload._order_id,payload._action,
  ],payload._client_mutation_id);
  const { data,error }=await supabase.rpc("transition_table_order_lifecycle_v2" as any,{
    _tenant_id:payload._tenant_id,_branch_id:payload._branch_id,_order_id:payload._order_id,
    _operation_id:pending.operationId,_action:payload._action,
  });
  clearForDefinitiveResult(pending.key,error);
  if(error) throw error;
  if(!data || typeof data!=="object") throw new Error("Table-order lifecycle returned an invalid receipt");
  return data;
}
