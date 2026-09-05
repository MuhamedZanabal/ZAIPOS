import { supabase } from "@/integrations/supabase/client";

export type DirectInventoryMovementType = "purchase" | "adjustment" | "waste" | "return";

export type InventoryBatchMovement = {
  productId: string;
  type: DirectInventoryMovementType;
  quantity: number;
  effectKey: string;
};

export type InventoryLevelTarget = {
  productId: string;
  targetQuantity: number;
  effectKey: string;
};

export function createInventoryMutationId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function recordInventoryBatchV2(args: {
  tenantId: string;
  branchId: string;
  inventoryCenterId: string;
  movements: InventoryBatchMovement[];
  clientMutationId: string;
  reason?: string | null;
}) {
  const { data, error } = await supabase.rpc("record_inventory_batch_v2" as any, {
    _tenant_id: args.tenantId,
    _branch_id: args.branchId,
    _inventory_center_id: args.inventoryCenterId,
    _movements: args.movements.map((movement) => ({
      product_id: movement.productId,
      movement_type: movement.type,
      quantity: movement.quantity,
      effect_key: movement.effectKey,
    })),
    _client_mutation_id: args.clientMutationId,
    _reason: args.reason ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function reconcileInventoryLevelsV2(args: {
  tenantId: string;
  branchId: string;
  inventoryCenterId: string;
  targets: InventoryLevelTarget[];
  clientMutationId: string;
  reason?: string | null;
}) {
  const { data, error } = await supabase.rpc("reconcile_inventory_levels_v2" as any, {
    _tenant_id: args.tenantId,
    _branch_id: args.branchId,
    _inventory_center_id: args.inventoryCenterId,
    _targets: args.targets.map((target) => ({
      product_id: target.productId,
      target_quantity: target.targetQuantity,
      effect_key: target.effectKey,
    })),
    _client_mutation_id: args.clientMutationId,
    _reason: args.reason ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function transferInventoryV2(args: {
  tenantId: string;
  branchId: string;
  productId: string;
  fromCenterId: string;
  toCenterId: string;
  quantity: number;
  reason?: string | null;
  clientMutationId: string;
}) {
  const { data, error } = await supabase.rpc("transfer_inventory_v2" as any, {
    _tenant_id: args.tenantId,
    _branch_id: args.branchId,
    _product_id: args.productId,
    _from_center_id: args.fromCenterId,
    _to_center_id: args.toCenterId,
    _quantity: args.quantity,
    _reason: args.reason ?? null,
    _client_mutation_id: args.clientMutationId,
  });
  if (error) throw error;
  return data as string;
}

export async function receivePurchaseOrderV2(args: {
  orderId: string;
  inventoryCenterId: string;
  clientMutationId: string;
}) {
  const { data, error } = await supabase.rpc("receive_purchase_order_v2" as any, {
    _order_id: args.orderId,
    _inventory_center_id: args.inventoryCenterId,
    _client_mutation_id: args.clientMutationId,
  });
  if (error) throw error;
  return data as string;
}

export async function completeProductionOrderV2(args: {
  orderId: string;
  produced: number;
  waste?: number;
  clientMutationId: string;
}) {
  const { data, error } = await supabase.rpc("complete_production_order_v2" as any, {
    _order_id: args.orderId,
    _produced: args.produced,
    _waste: args.waste ?? 0,
    _client_mutation_id: args.clientMutationId,
  });
  if (error) throw error;
  return data as string;
}
