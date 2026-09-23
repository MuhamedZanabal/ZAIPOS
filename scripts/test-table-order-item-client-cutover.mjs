import { readFile } from "node:fs/promises";

const files = {
  helper: "src/lib/tableOrderItems.ts",
  tableOrder: "src/modules/tables/TableOrder.tsx",
  kds: "src/modules/kds/KDS.tsx",
  syncEngine: "src/hooks/useSyncEngine.ts",
  migration: "supabase/migrations/20260923071500_atomic_table_order_item_mutations.sql",
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
requireText("kds", 'rpc("start_preparing_table_item"', "server-owned kitchen start transition");
requireText("kds", 'rpc("mark_table_item_ready"', "server-owned kitchen ready transition");
forbidPattern("syncEngine", /\.from\(["']table_order_items["']\)[\s\S]{0,160}\.(?:insert|update|delete)\s*\(/,
  "queued direct table-order-item mutation");
requireText("migration", "DROP POLICY IF EXISTS toi_member_all", "broad mutation-policy removal");
requireText("migration", "REVOKE INSERT, UPDATE, DELETE", "authenticated direct-DML revocation");
requireText("migration", "bhd_numeric_to_fils(i.unit_price)", "integer-fils order arithmetic");

if (failures.length) {
  throw new Error(`Table-order item cutover incomplete:\n- ${failures.join("\n- ")}`);
}
console.log("PASS: restaurant item writes use an atomic replay-safe command; renderer direct DML is absent and kitchen transitions remain server-owned.");
