import { supabase } from "@/integrations/supabase/client";

export interface AuthoritativeTableCartItem {
  product_id: string;
  quantity: number;
  modifier_option_ids: string[];
  notes: string | null;
}

const PENDING_PREFIX = "zaipos:table-cart-operation:";

function canonicalItems(items: AuthoritativeTableCartItem[]) {
  return items.map((item) => ({
    product_id: item.product_id,
    quantity: item.quantity,
    modifier_option_ids: [...new Set(item.modifier_option_ids)].sort(),
    notes: item.notes?.trim() || null,
  }));
}

export async function appendTableCart(args: {
  tenantId: string;
  branchId: string;
  tableId: string;
  items: AuthoritativeTableCartItem[];
  operationId?: string;
}) {
  if (args.items.length === 0) throw new Error("The table cart is empty");
  const items = canonicalItems(args.items);
  const storageKey = `${PENDING_PREFIX}${JSON.stringify([args.tenantId, args.branchId, args.tableId, items])}`;
  const persisted = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(storageKey);
  const operationId = args.operationId ?? persisted ?? `table-cart:${crypto.randomUUID()}`;
  if (!args.operationId && typeof sessionStorage !== "undefined") sessionStorage.setItem(storageKey, operationId);

  const { data, error } = await supabase.rpc("append_table_cart_v2" as any, {
    _tenant_id: args.tenantId,
    _branch_id: args.branchId,
    _table_id: args.tableId,
    _operation_id: operationId,
    _items: items,
  });
  if (error) {
    if (typeof sessionStorage !== "undefined" && !/fetch|network|connection|timeout/i.test(error.message)) {
      sessionStorage.removeItem(storageKey);
    }
    throw error;
  }
  if (typeof data !== "string") {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(storageKey);
    throw new Error("Table-cart command returned an invalid receipt");
  }
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(storageKey);
  return { orderId: data, operationId };
}
