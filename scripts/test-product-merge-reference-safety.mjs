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
    'schema', child_ns.nspname,
    'table', child.relname,
    'constraint', con.conname,
    'columns', ARRAY(
      SELECT att.attname
      FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality)
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid
       AND att.attnum = key.attnum
      ORDER BY key.ordinality
    ),
    'referenced_columns', ARRAY(
      SELECT att.attname
      FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ordinality)
      JOIN pg_attribute att
        ON att.attrelid = con.confrelid
       AND att.attnum = key.attnum
      ORDER BY key.ordinality
    ),
    'definition', pg_get_constraintdef(con.oid)
  ) ORDER BY child_ns.nspname, child.relname, con.conname), '[]'::json)::text
  FROM pg_constraint con
  JOIN pg_class child ON child.oid = con.conrelid
  JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
  WHERE con.contype = 'f'
    AND con.confrelid = 'public.products'::regclass
    AND child_ns.nspname = 'public';
`));

const identity = (row) => `${row.schema}.${row.table}.${row.constraint}[${row.columns.join(",")}]`;
const manifest = rows.map((row) => ({ ...row, identity: identity(row) }));
process.stdout.write(`PRODUCT_FK_MANIFEST=${JSON.stringify(manifest)}\n`);

// RED diagnostic contract: the previous table-level policy is intentionally retained
// only long enough to expose every exact FK identity produced by the fully migrated
// PostgreSQL schema. A table-level key is unsafe because one table may contain multiple
// product references with different merge semantics. This commit must remain red until
// the exact-reference policy replaces it.
const legacyTableClassifications = new Map([
  ["inventory_stocks", "transferred"],
  ["inventory_movements", "historical"],
  ["sale_items", "historical"],
  ["product_barcodes", "transferred"],
  ["product_prices", "historical"],
  ["product_financial_operations", "historical"],
  ["product_merge_aliases", "merge_ledger"],
  ["product_merge_operations", "merge_ledger"],
]);

const unclassified = manifest.filter((row) => !legacyTableClassifications.has(row.table));
const refsByTable = new Map();
for (const row of manifest) {
  const key = `${row.schema}.${row.table}`;
  refsByTable.set(key, [...(refsByTable.get(key) ?? []), row.identity]);
}
const ambiguousTablePolicies = [...refsByTable.entries()]
  .filter(([, refs]) => refs.length > 1)
  .map(([table, refs]) => ({ table, refs }));

throw new Error(
  `Exact product-reference policy required. ` +
  `unclassified=${JSON.stringify(unclassified)} ` +
  `multi_reference_tables=${JSON.stringify(ambiguousTablePolicies)}`,
);
