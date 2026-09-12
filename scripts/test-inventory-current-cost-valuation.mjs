import fs from "node:fs";
import path from "node:path";

const migrationsDir = path.resolve("supabase/migrations");
const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const sql = files.map((name) => fs.readFileSync(path.join(migrationsDir, name), "utf8")).join("\n").toLowerCase();

const required = [
  "get_inventory_current_cost_valuation_v1",
  "quantity_milliunits",
  "value_millifils",
  "value_fils",
  "coverage_status",
  "current_branch_cost",
  "product_prices",
  "inventory_stocks",
  "has_branch_role",
];

const missing = required.filter((token) => !sql.includes(token));
if (missing.length) {
  throw new Error(`Current-cost inventory valuation contract is incomplete. missing=${JSON.stringify(missing)}`);
}

if (!sql.includes("round") || !sql.includes("1000")) {
  throw new Error("Valuation must define deterministic exact-fils rounding from three-decimal inventory quantities.");
}

console.log("Inventory current-cost valuation static contract satisfied.");
