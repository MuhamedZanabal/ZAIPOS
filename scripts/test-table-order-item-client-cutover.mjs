import { readFile } from "node:fs/promises";

const files = {
  helper: "src/lib/tableOrderItems.ts",
  kitchenHelper: "src/lib/tableKitchen.ts",
  tableOrder: "src/modules/tables/TableOrder.tsx",
  kds: "src/modules/kds/KDS.tsx",
  syncEngine: "src/hooks/useSyncEngine.ts",
  migration: "supabase/migrations/20260923071500_atomic_table_order_item_mutations.sql",
  kitchenMigration: "supabase/migrations/20260923111500_scoped_table_kitchen_transitions.sql",
  lifecycleMigration: "supabase/migrations/20260923130000_scoped_table_order_lifecycle.sql",
};
const source = {};
for (const [key, path] of Object.entries(files)) {
  source[key] = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const failures = [];
const requireText = (key, text, label) => {
  if (!source[key].includes(text)) failures.push(`${files[key]} missing ${label}`);
};
const forbidPattern = (key, pattern, label) => {
  if (pattern.test(source[key])) failures.push(`${files[key]} still contains ${label}`);
};

requireText("helper", 'mutate_table_order_item_v2', "atomic mutation RPC");
requireText("helper", "sessionStorage.setItem", "persist-before-submit operation identity");
requireText("tableOrder", "mutateTableOrderItem", "atomic table-item helper usage");
forbidPattern("tableOrder", /\.from\(["']table_order_items["']\)[\s\S]{0,160}\.(?:insert|update|delete)\s*\(/,
  "direct table-order-item mutation");
requireText("kitchenHelper", 'transition_table_item_v2', "scoped item-transition RPC");
requireText("kitchenHelper", 'transition_table_order_v2', "scoped order-transition RPC");
requireText("kitchenHelper", 'transition_table_order_lifecycle_v2', "scoped lifecycle RPC");
requireText("kitchenHelper", "sessionStorage.setItem", "persist-before-submit transition identity");
requireText("kds", "transitionTableItem", "scoped kitchen transition helper");
for (const legacy of ["start_preparing_table_item","mark_table_item_ready","dispatch_table_item","undispatch_table_item","send_table_order_to_kitchen","mark_table_order_ready"]) {
  forbidPattern("tableOrder", new RegExp(`rpc\\(["']${legacy}["']`), `renderer call to legacy ${legacy}`);
  forbidPattern("kds", new RegExp(`rpc\\(["']${legacy}["']`), `KDS call to legacy ${legacy}`);
}
forbidPattern("tableOrder", /\.from\(["']table_orders["']\)[\s\S]{0,160}\.update\s*\(/,
  "direct table-order lifecycle mutation");
forbidPattern("tableOrder", /rpc\(["']send_table_order_to_cashier["']/,
  "renderer call to legacy send_table_order_to_cashier");
forbidPattern("syncEngine", /rpc\(["']send_table_order_to_cashier["']/,
  "queue replay through legacy send_table_order_to_cashier");
forbidPattern("syncEngine", /\.from\(["']table_order_items["']\)[\s\S]{0,160}\.(?:insert|update|delete)\s*\(/,
  "queued direct table-order-item mutation");
requireText("migration", "DROP POLICY IF EXISTS toi_member_all", "broad mutation-policy removal");
requireText("migration", "REVOKE INSERT, UPDATE, DELETE", "authenticated direct-DML revocation");
requireText("migration", "bhd_numeric_to_fils(i.unit_price)", "integer-fils order arithmetic");
requireText("kitchenMigration", "REVOKE EXECUTE ON FUNCTION public.dispatch_table_item", "legacy dispatch revocation");
requireText("kitchenMigration", "apply_table_dispatch_inventory_effect_v2", "private dispatch inventory boundary");
requireText("kitchenMigration", "transition_table_item_v2", "replay-safe item transition");
requireText("lifecycleMigration", "REVOKE UPDATE, DELETE ON public.table_orders", "direct lifecycle-DML revocation");
requireText("lifecycleMigration", "REVOKE EXECUTE ON FUNCTION public.send_table_order_to_cashier", "legacy cashier-transition revocation");
requireText("lifecycleMigration", "transition_table_order_lifecycle_v2", "atomic replay-safe lifecycle command");

if (failures.length) {
  throw new Error(`Table-order item cutover incomplete:\n- ${failures.join("\n- ")}`);
}
console.log("PASS: restaurant item writes use an atomic replay-safe command; renderer direct DML is absent and kitchen transitions remain server-owned.");
