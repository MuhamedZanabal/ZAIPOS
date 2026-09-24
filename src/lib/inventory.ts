import { desktopAuthorization } from "@/lib/desktopAuthorization";

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

async function runInventoryCommand(command: string, payload: Record<string, unknown>, tenantId: string, branchId: string) {
  if (!window.electron?.inventoryCommand) throw new Error("Trusted desktop inventory authority is unavailable");
  const authorization = await desktopAuthorization();
  if (authorization.tenantId !== tenantId || authorization.branchId !== branchId) throw new Error("Inventory command scope does not match the selected desktop branch");
  return window.electron.inventoryCommand(command, payload, authorization);
}

export async function recordInventoryBatchV2(args: {
  tenantId: string;
  branchId: string;
  inventoryCenterId: string;
  movements: InventoryBatchMovement[];
  clientMutationId: string;
  reason?: string | null;
}) {
  return runInventoryCommand("batch", {
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
  }, args.tenantId, args.branchId);
}

export async function reconcileInventoryLevelsV2(args: {
  tenantId: string;
  branchId: string;
  inventoryCenterId: string;
  targets: InventoryLevelTarget[];
  clientMutationId: string;
  reason?: string | null;
}) {
  return runInventoryCommand("reconcile", {
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
  }, args.tenantId, args.branchId);
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
  return runInventoryCommand("transfer", {
    _tenant_id: args.tenantId,
    _branch_id: args.branchId,
    _product_id: args.productId,
    _from_center_id: args.fromCenterId,
    _to_center_id: args.toCenterId,
    _quantity: args.quantity,
    _reason: args.reason ?? null,
    _client_mutation_id: args.clientMutationId,
  }, args.tenantId, args.branchId);
}

export async function receivePurchaseOrderV2(args: {
  tenantId: string;
  branchId: string;
  orderId: string;
  inventoryCenterId: string;
  clientMutationId: string;
}) {
  return runInventoryCommand("receive", {
    _tenant_id: args.tenantId,
    _branch_id: args.branchId,
    _order_id: args.orderId,
    _inventory_center_id: args.inventoryCenterId,
    _client_mutation_id: args.clientMutationId,
  }, args.tenantId, args.branchId);
}

export async function completeProductionOrderV2(args: {
  tenantId: string;
  branchId: string;
  orderId: string;
  produced: number;
  waste?: number;
  clientMutationId: string;
}) {
  return runInventoryCommand("production", {
    _tenant_id: args.tenantId,
    _branch_id: args.branchId,
    _order_id: args.orderId,
    _produced: args.produced,
    _waste: args.waste ?? 0,
    _client_mutation_id: args.clientMutationId,
  }, args.tenantId, args.branchId);
}
