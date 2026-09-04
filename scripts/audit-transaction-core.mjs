import fs from "node:fs";

const failures = [];
const requireText = (path, fragments) => {
  const text = fs.readFileSync(path, "utf8");
  for (const fragment of fragments) {
    if (!text.includes(fragment)) failures.push(`${path}: missing invariant marker: ${fragment}`);
  }
  return text;
};

const forbidText = (path, fragments) => {
  const text = fs.readFileSync(path, "utf8");
  for (const fragment of fragments) {
    if (text.includes(fragment)) failures.push(`${path}: forbidden legacy transaction pattern: ${fragment}`);
  }
};

const migration = "supabase/migrations/20260905000100_transaction_core_foundation.sql";
requireText(migration, [
  "CREATE OR REPLACE FUNCTION public.bhd_to_fils",
  "numeric(18,3)",
  "CREATE TABLE IF NOT EXISTS public.checkout_operations",
  "UNIQUE (tenant_id, client_mutation_id)",
  "request_payload IS DISTINCT FROM _request_payload",
  "_payment_total_fils <> _total_fils",
  "_cash_session_id uuid DEFAULT NULL",
  "Multiple cash sessions are open",
  "Manager authorization is required for line discounts",
  "sale.checkout_committed",
]);

requireText("src/lib/money.ts", [
  "export function bhdToFils",
  "export function assertFils",
  "export function percentageOfFils",
]);
requireText("src/modules/pos/paymentAllocations.ts", [
  "PaymentAllocation",
  "assertAllocationsSettle",
  "normalizePaymentAllocations",
]);
requireText("src/modules/pos/PaymentDialog.tsx", [
  "Payment split",
  "PaymentAllocation[]",
  "assertAllocationsSettle",
]);

forbidText("src/modules/pos/PaymentDialog.tsx", [
  "onConfirm: (method: PayMethod",
]);
forbidText("src/modules/pos/POS.tsx", [
  "const payments = [{ method, amount: payableTotal",
  "_client_mutation_id: crypto.randomUUID()",
]);

if (failures.length) {
  console.error(`ZAIPOS transaction-core audit failed with ${failures.length} finding(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("ZAIPOS transaction-core audit passed.");
