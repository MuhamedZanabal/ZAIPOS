import { readFile } from "node:fs/promises";

const files = {
  helper: "src/lib/inventory.ts",
  inventory: "src/modules/inventory/Inventory.tsx",
  ocr: "src/modules/inventory/components/InvoiceOCRDialog.tsx",
  ean: "src/modules/inventory/components/EanImportDialog.tsx",
  transfer: "src/modules/inventory/components/TransferDialog.tsx",
  suppliers: "src/modules/suppliers/Suppliers.tsx",
  production: "src/modules/production/Production.tsx",
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

requireText("helper", 'record_inventory_batch_v2', "record_inventory_batch_v2 helper");
requireText("helper", 'transfer_inventory_v2', "transfer_inventory_v2 helper");
requireText("helper", 'receive_purchase_order_v2', "receive_purchase_order_v2 helper");
requireText("helper", 'complete_production_order_v2', "complete_production_order_v2 helper");
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

const allClientSource = Object.values(source).join("\n");
if (allClientSource.includes('"apply_inventory_movement"')) {
  failures.push("client inventory surfaces still reference the revoked apply_inventory_movement RPC");
}

if (failures.length) {
  throw new Error(`Inventory client cutover incomplete:\n- ${failures.join("\n- ")}`);
}

console.log("PASS: all inventory mutation UIs use v2 command helpers and no client surface invokes the revoked low-level inventory primitive.");
