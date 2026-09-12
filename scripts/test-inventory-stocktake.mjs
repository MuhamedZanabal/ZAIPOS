import { readFile } from "node:fs/promises";

const migrationPath = new URL("../supabase/migrations/20260912050000_inventory_stocktake_reconciliation.sql", import.meta.url);
let migration;
try {
  migration = await readFile(migrationPath, "utf8");
} catch {
  throw new Error("P1 stocktake reconciliation missing: expected 20260912050000_inventory_stocktake_reconciliation.sql");
}

const required = [
  "CREATE TABLE public.inventory_stocktakes",
  "CREATE TABLE public.inventory_stocktake_lines",
  "public.start_inventory_stocktake_v1",
  "public.record_inventory_stocktake_count_v1",
  "public.commit_inventory_stocktake_v1",
  "expected_quantity",
  "counted_quantity",
  "variance_quantity",
  "client_mutation_id",
  "FOR UPDATE",
  "public.apply_inventory_movement",
  "public.product_inventory_controls",
  "lot_tracking_enabled",
  "SECURITY DEFINER",
  "REVOKE",
  "GRANT EXECUTE",
];

for (const marker of required) {
  if (!migration.includes(marker)) {
    throw new Error(`P1 stocktake reconciliation contract missing marker: ${marker}`);
  }
}

const unsafe = [
  /expected_quantity\s+double precision/i,
  /counted_quantity\s+double precision/i,
  /variance_quantity\s+double precision/i,
  /UPDATE\s+public\.inventory_stocks\s+SET\s+quantity/i,
];
for (const pattern of unsafe) {
  if (pattern.test(migration)) {
    throw new Error(`P1 stocktake reconciliation contains unsafe contract: ${pattern}`);
  }
}

if (!/status[^;]*(draft|open|committed|cancelled)/is.test(migration)) {
  throw new Error("P1 stocktake reconciliation must define an explicit lifecycle");
}

if (!/lot_tracking_enabled[\s\S]*RAISE EXCEPTION|RAISE EXCEPTION[\s\S]*lot_tracking_enabled/i.test(migration)) {
  throw new Error("P1 stocktake reconciliation must fail closed for lot-tracked products until lot-level reconciliation is explicit");
}

process.stdout.write("Inventory stocktake static contract PASS.\n");
