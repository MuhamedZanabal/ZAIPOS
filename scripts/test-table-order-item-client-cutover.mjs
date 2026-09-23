import { readFile } from "node:fs/promises";

const files = {
  helper: "src/lib/tableOrderItems.ts",
  kitchenHelper: "src/lib/tableKitchen.ts",
  tableOrder: "src/modules/tables/TableOrder.tsx",
  tables: "src/modules/tables/Tables.tsx",
  waiter: "src/modules/waiter/WaiterDashboard.tsx",
  kds: "src/modules/kds/KDS.tsx",
  syncEngine: "src/hooks/useSyncEngine.ts",
  pos: "src/modules/pos/POS.tsx",
  syncQueue: "src/lib/syncQueue.ts",
  migration: "supabase/migrations/20260923071500_atomic_table_order_item_mutations.sql",
  kitchenMigration: "supabase/migrations/20260923111500_scoped_table_kitchen_transitions.sql",
  lifecycleMigration: "supabase/migrations/20260923130000_scoped_table_order_lifecycle.sql",
  openMigration: "supabase/migrations/20260923152500_scoped_table_order_open.sql",
  legacyCartMigration: "supabase/migrations/20260923170500_retire_untrusted_table_cart_upsert.sql",
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
requireText("kitchenHelper", 'open_table_order_v2', "scoped table-order opening RPC");
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
forbidPattern("tables", /\.from\(["']table_orders["']\)[\s\S]{0,160}\.insert\s*\(/,
  "direct table-order creation");
forbidPattern("waiter", /\.from\(["']table_orders["']\)[\s\S]{0,160}\.insert\s*\(/,
  "direct waiter table-order creation");
requireText("tables", "openTableOrder", "scoped table-order opening helper");
requireText("waiter", "openTableOrder", "scoped waiter table-order opening helper");
forbidPattern("pos", /rpc\(["']upsert_table_order_items["']/, "renderer call to untrusted table-cart RPC");
forbidPattern("syncEngine", /rpc\(["']upsert_table_order_items["']/, "queue replay through untrusted table-cart RPC");
requireText("syncQueue", '|| type === "UPSERT_TABLE_ORDER_ITEMS"', "table-cart queue fail-closed guard");
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
requireText("openMigration", "REVOKE INSERT ON public.table_orders", "direct table-order INSERT revocation");
requireText("openMigration", "open_table_order_v2", "scoped replay-safe order-opening command");
requireText("legacyCartMigration", "REVOKE ALL ON FUNCTION public.upsert_table_order_items", "legacy table-cart RPC revocation");

if (failures.length) {
  throw new Error(`Table-order item cutover incomplete:\n- ${failures.join("\n- ")}`);
}
console.log("PASS: restaurant item writes use an atomic replay-safe command; renderer direct DML is absent and kitchen transitions remain server-owned.");
