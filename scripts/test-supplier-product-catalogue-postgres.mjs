import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

function scalar(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(label, actual, expected) {
  if (!actual.includes(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}

assertEqual(
  "supplier_products table exists",
  scalar("SELECT to_regclass('public.supplier_products') IS NOT NULL;"),
  "t",
);
assertEqual(
  "supplier product operations table exists",
  scalar("SELECT to_regclass('public.supplier_product_operations') IS NOT NULL;"),
  "t",
);

for (const [column, type] of [
  ["tenant_id", "uuid"],
  ["branch_id", "uuid"],
  ["supplier_id", "uuid"],
  ["product_id", "uuid"],
  ["supplier_sku", "text"],
  ["supplier_product_name", "text"],
  ["pack_quantity_milli", "bigint"],
  ["current_cost_fils", "bigint"],
  ["lead_time_days", "integer"],
  ["is_preferred", "boolean"],
  ["status", "text"],
]) {
  assertEqual(
    `supplier_products.${column} type`,
    scalar(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='supplier_products' AND column_name='${column}';`),
    type,
  );
}

const constraints = scalar(`
  SELECT COALESCE(string_agg(pg_get_constraintdef(c.oid), E'\n' ORDER BY c.conname),'')
  FROM pg_constraint c
  WHERE c.conrelid='public.supplier_products'::regclass;
`);
assertIncludes("branch structural FK", constraints, "FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)");
assertIncludes("supplier structural FK", constraints, "FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id)");
assertIncludes("product structural FK", constraints, "FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)");
assertIncludes("pack quantity must be positive", constraints, "pack_quantity_milli > 0");
assertIncludes("cost must be nonnegative exact fils", constraints, "current_cost_fils >= 0");

const indexes = scalar(`
  SELECT COALESCE(string_agg(indexdef, E'\n' ORDER BY indexname),'')
  FROM pg_indexes
  WHERE schemaname='public' AND tablename='supplier_products';
`);
assertIncludes("one supplier-product mapping per branch", indexes, "tenant_id, branch_id, supplier_id, product_id");
assertIncludes("supplier SKU collision protection", indexes, "supplier_sku");

for (const signature of [
  "public.upsert_supplier_product_v1(uuid,uuid,uuid,uuid,text,text,bigint,bigint,integer,boolean,text,text)",
  "public.list_supplier_products_v1(uuid,uuid,uuid)",
]) {
  assertEqual(
    `required function ${signature}`,
    scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`),
    "t",
  );
}

for (const table of ["supplier_products", "supplier_product_operations"]) {
  for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
    assertEqual(
      `${table} authenticated direct ${privilege} denied`,
      scalar(`SELECT has_table_privilege('authenticated','public.${table}','${privilege}');`),
      "f",
    );
  }
  assertEqual(
    `${table} RLS enabled`,
    scalar(`SELECT relrowsecurity FROM pg_class WHERE oid='public.${table}'::regclass;`),
    "t",
  );
}

console.log("Supplier product catalogue PostgreSQL contract passed.");
