import fs from "node:fs";

const migration = "supabase/migrations/20260912060000_stocktake_cycle_count.sql";
const failures = [];

function requireFile(path) {
  if (!fs.existsSync(path)) {
    failures.push(`${path}: missing required stocktake migration`);
    return "";
  }
  return fs.readFileSync(path, "utf8");
}

function requireText(text, marker) {
  if (!text.includes(marker)) failures.push(`${migration}: missing invariant marker: ${marker}`);
}

const sql = requireFile(migration);
for (const marker of [
  "CREATE TABLE public.stocktakes",
  "CREATE TABLE public.stocktake_items",
  "CREATE OR REPLACE FUNCTION public.start_stocktake_v1",
  "CREATE OR REPLACE FUNCTION public.record_stocktake_count_v1",
  "CREATE OR REPLACE FUNCTION public.finalize_stocktake_v1",
  "CREATE OR REPLACE FUNCTION public.cancel_stocktake_v1",
  "expected_quantity numeric",
  "expected_stock_updated_at timestamptz",
  "counted_quantity numeric",
  "FOR UPDATE",
  "expected_stock_updated_at IS DISTINCT FROM",
  "Inventory changed after this stocktake started",
  "reconcile_inventory_levels_v2",
  "finalize_client_mutation_id",
  "inventory_operation_id",
  "stocktake.started",
  "stocktake.counted",
  "stocktake.finalized",
  "stocktake.cancelled",
  "REVOKE ALL ON public.stocktakes FROM PUBLIC, anon, authenticated",
  "REVOKE ALL ON public.stocktake_items FROM PUBLIC, anon, authenticated",
]) requireText(sql, marker);

for (const forbidden of [
  "GRANT INSERT ON public.stocktakes TO authenticated",
  "GRANT UPDATE ON public.stocktakes TO authenticated",
  "GRANT DELETE ON public.stocktakes TO authenticated",
  "GRANT INSERT ON public.stocktake_items TO authenticated",
  "GRANT UPDATE ON public.stocktake_items TO authenticated",
  "GRANT DELETE ON public.stocktake_items TO authenticated",
]) {
  if (sql.includes(forbidden)) failures.push(`${migration}: forbidden direct authenticated mutation grant: ${forbidden}`);
}

if (failures.length) {
  console.error(`ZAIPOS stocktake static contract failed with ${failures.length} finding(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("ZAIPOS stocktake static contract passed.");
