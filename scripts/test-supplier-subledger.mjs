import fs from "node:fs";
import path from "node:path";

const migrationsDir = path.resolve("supabase/migrations");
const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const sql = files.map((name) => fs.readFileSync(path.join(migrationsDir, name), "utf8")).join("\n").toLowerCase();

const required = [
  "supplier_ledger_entries",
  "supplier_financial_operations",
  "record_supplier_payment_v1",
  "get_supplier_statement_v1",
  "purchase_receipt",
  "amount_fils",
  "request_hash",
  "line_total_fils",
  "receive_purchase_order_v2",
  "has_branch_role",
];

const missing = required.filter((token) => !sql.includes(token));
if (missing.length) {
  throw new Error(`Supplier subledger production contract is incomplete. missing=${JSON.stringify(missing)}`);
}

for (const forbidden of [
  "grant insert on public.supplier_ledger_entries to authenticated",
  "grant update on public.supplier_ledger_entries to authenticated",
  "grant delete on public.supplier_ledger_entries to authenticated",
]) {
  if (sql.includes(forbidden)) {
    throw new Error(`Supplier ledger must be append-only behind authoritative commands: ${forbidden}`);
  }
}

console.log("Supplier subledger static contract satisfied.");
