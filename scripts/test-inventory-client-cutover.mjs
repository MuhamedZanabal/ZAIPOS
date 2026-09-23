import { readFile } from "node:fs/promises";

const files = {
  helper: "src/lib/inventory.ts",
  inventory: "src/modules/inventory/Inventory.tsx",
  ocr: "src/modules/inventory/components/InvoiceOCRDialog.tsx",
  ean: "src/modules/inventory/components/EanImportDialog.tsx",
  transfer: "src/modules/inventory/components/TransferDialog.tsx",
  suppliers: "src/modules/suppliers/Suppliers.tsx",
  production: "src/modules/production/Production.tsx",
  dataManagement: "src/modules/settings/DataManagement.tsx",
  syncEngine: "src/hooks/useSyncEngine.ts",
  syncQueue: "src/lib/syncQueue.ts",
};

const source = {};
for (const [key, path] of Object.entries(files)) {
  source[key] = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const failures = [];
const requireText = (key, text, label) => {
  if (!source[key].includes(text)) failures.push(`${files[key]} missing ${label}`);
};
const forbidText = (key, text, label) => {
  if (source[key].includes(text)) failures.push(`${files[key]} still contains ${label}`);
};

requireText("helper", 'runInventoryCommand("batch"', "native device-bound batch helper");
requireText("helper", 'runInventoryCommand("transfer"', "native device-bound transfer helper");
requireText("helper", 'runInventoryCommand("receive"', "native device-bound receiving helper");
requireText("helper", 'runInventoryCommand("production"', "native device-bound production helper");
requireText("helper", 'runInventoryCommand("reconcile"', "native device-bound reconciliation helper");
forbidText("helper", 'supabase.rpc(', "renderer-callable inventory RPC");
forbidText("helper", '"apply_inventory_movement"', "direct low-level inventory RPC");

requireText("inventory", "recordInventoryBatchV2", "v2 manual movement call");
forbidText("inventory", "applyInventoryMovement", "legacy manual movement helper");

requireText("ocr", "recordInventoryBatchV2", "atomic OCR batch call");
forbidText("ocr", "applyInventoryMovement", "client-side OCR movement loop");

requireText("ean", "recordInventoryBatchV2", "atomic EAN stock batch call");
forbidText("ean", "applyInventoryMovement", "client-side EAN movement loop");

requireText("transfer", "transferInventoryV2", "v2 transfer call");
forbidText("transfer", 'rpc("transfer_inventory"', "legacy transfer RPC");

requireText("suppliers", "receivePurchaseOrderV2", "atomic purchase receive call");
forbidText("suppliers", 'rpc("apply_inventory_movement"', "client-side purchase receive movement loop");

requireText("production", "completeProductionOrderV2", "v2 production completion call");
forbidText("production", 'rpc("complete_production_order"', "legacy production RPC");

requireText("dataManagement", "reconcileInventoryLevelsV2", "server-authoritative data-management physical reconciliation");
forbidText("dataManagement", "applyInventoryMovement", "legacy data-management movement helper");

const allClientSource = Object.values(source).join("\n");
if (allClientSource.includes('"apply_inventory_movement"')) {
  failures.push("client inventory surfaces still reference the revoked apply_inventory_movement RPC");
}

forbidText("syncEngine", "from('table_order_items').insert", "non-atomic queued table-item insert");
forbidText("syncEngine", "if (item.type === 'ADD_TABLE_ORDER_ITEMS')", "legacy table-item replay branch");
requireText("syncQueue", 'type === "ADD_TABLE_ORDER_ITEMS"', "legacy table-item quarantine guard");

if (failures.length) {
  throw new Error(`Inventory client cutover incomplete:\n- ${failures.join("\n- ")}`);
}

console.log("PASS: all inventory mutation UIs use native device-bound commands and no client surface invokes a legacy inventory RPC.");
