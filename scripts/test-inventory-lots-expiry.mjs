import { readFile } from "node:fs/promises";

const path = new URL("../supabase/migrations/20260912040000_inventory_lots_expiry.sql", import.meta.url);
let migration;
try {
  migration = await readFile(path, "utf8");
} catch {
  throw new Error("P1 inventory lots/expiry missing: expected 20260912040000_inventory_lots_expiry.sql");
}

const required = [
  "CREATE TABLE public.inventory_lots",
  "CREATE TABLE public.inventory_lot_movements",
  "CREATE TABLE public.product_inventory_controls",
  "public.configure_product_lot_tracking_v1",
  "public.receive_inventory_lot_v1",
  "public.allocate_inventory_lots_fefo_v1",
  "expiry_date",
  "batch_number",
  "client_mutation_id",
  "claim_inventory_operation_v2",
  "FOR UPDATE",
  "REVOKE",
  "GRANT EXECUTE",
];

for (const marker of required) {
  if (!migration.includes(marker)) {
    throw new Error(`P1 inventory lots/expiry contract missing marker: ${marker}`);
  }
}

const unsafe = [
  /quantity\s+double precision/i,
  /quantity\s+real/i,
  /ON DELETE CASCADE[^;]*inventory_lots/i,
];
for (const pattern of unsafe) {
  if (pattern.test(migration)) {
    throw new Error(`P1 inventory lots/expiry contains unsafe contract: ${pattern}`);
  }
}

if (!/CHECK\s*\([^)]*quantity[^)]*>=?\s*0/i.test(migration)) {
  throw new Error("P1 inventory lots/expiry must constrain lot quantities to non-negative values");
}

if (!/expiry_date[^;]*(CHECK|CONSTRAINT)|CHECK[^;]*expiry_date/is.test(migration)) {
  throw new Error("P1 inventory lots/expiry must enforce expiry-date validity at the database boundary");
}

if (!/lot[_ ]tracking/i.test(migration) || !/aggregate stock/i.test(migration)) {
  throw new Error("P1 inventory lots/expiry must document the aggregate-stock compatibility boundary");
}

console.log("Inventory lots/expiry migration contract present.");
