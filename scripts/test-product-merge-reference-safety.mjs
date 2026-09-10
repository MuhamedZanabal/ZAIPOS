import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

function scalar(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

const rows = JSON.parse(scalar(`
  SELECT COALESCE(json_agg(json_build_object(
    'table', child.relname,
    'constraint', con.conname,
    'definition', pg_get_constraintdef(con.oid)
  ) ORDER BY child.relname, con.conname), '[]'::json)::text
  FROM pg_constraint con
  JOIN pg_class child ON child.oid = con.conrelid
  JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
  WHERE con.contype = 'f'
    AND con.confrelid = 'public.products'::regclass
    AND child_ns.nspname = 'public';
`));

// Each direct FK into products must be deliberately classified before product merge
// can be considered safe. "transferred" means the merge command moves mutable state;
// "historical" means IDs intentionally remain immutable; "merge_ledger" is the alias/
// operation evidence that defines the consolidation itself. New constraints fail closed.
const classifications = new Map([
  ["inventory_stocks", "transferred"],
  ["inventory_movements", "historical"],
  ["sale_items", "historical"],
  ["product_barcodes", "transferred"],
  ["product_prices", "historical"],
  ["product_financial_operations", "historical"],
  ["product_merge_aliases", "merge_ledger"],
  ["product_merge_operations", "merge_ledger"],
]);

const unclassified = rows.filter((row) => !classifications.has(row.table));
if (unclassified.length > 0) {
  throw new Error(`Unclassified product reference constraints: ${JSON.stringify(unclassified)}`);
}

process.stdout.write(`Product merge FK safety PASS: ${rows.length} product-reference constraints are explicitly classified.\n`);
