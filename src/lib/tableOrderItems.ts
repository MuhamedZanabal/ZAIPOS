import { supabase } from "@/integrations/supabase/client";

type TableItemAction = "add" | "set_quantity" | "delete";

const PENDING_PREFIX = "zaipos:table-item-operation:";

function pendingKey(args: {
  tenantId: string; branchId: string; orderId: string; action: TableItemAction;
  itemId?: string | null; productId?: string | null; quantity?: number | null; notes?: string | null;
}) {
  return `${PENDING_PREFIX}${JSON.stringify([
    args.tenantId, args.branchId, args.orderId, args.action, args.itemId ?? null,
    args.productId ?? null, args.quantity ?? null, args.notes?.trim() || null,
  ])}`;
}

export async function mutateTableOrderItem(args: {
  tenantId: string;
  branchId: string;
  orderId: string;
  action: TableItemAction;
  itemId?: string | null;
  productId?: string | null;
  quantity?: number | null;
  notes?: string | null;
  operationId?: string;
}) {
  const storageKey = pendingKey(args);
  const persisted = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(storageKey);
  const operationId = args.operationId ?? persisted ?? `table-item:${crypto.randomUUID()}`;
  if (!args.operationId && typeof sessionStorage !== "undefined") sessionStorage.setItem(storageKey, operationId);
  const { data, error } = await supabase.rpc("mutate_table_order_item_v2" as any, {
    _tenant_id: args.tenantId,
    _branch_id: args.branchId,
    _order_id: args.orderId,
    _operation_id: operationId,
    _action: args.action,
    _item_id: args.itemId ?? null,
    _product_id: args.productId ?? null,
    _quantity: args.quantity ?? null,
    _notes: args.notes?.trim() || null,
  });
  if (error) {
    if (typeof sessionStorage !== "undefined" && !/fetch|network|connection|timeout/i.test(error.message)) {
      sessionStorage.removeItem(storageKey);
    }
    throw error;
  }
  if (typeof data !== "string") {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(storageKey);
    throw new Error("Table-item command returned an invalid receipt");
  }
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(storageKey);
  return { itemId: data, operationId };
}
