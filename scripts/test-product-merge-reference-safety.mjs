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

const POLICY = Object.freeze({
  HISTORICAL_RETAIN: "HISTORICAL_RETAIN",
  TRANSFER_TO_CANONICAL: "TRANSFER_TO_CANONICAL",
  BLOCK_WHILE_ACTIVE: "BLOCK_WHILE_ACTIVE",
  STATE_DEPENDENT: "STATE_DEPENDENT",
});

// Every FK to products is classified by exact schema/table/constraint/column identity.
// This is deliberately not table-level: several tables carry multiple product roles.
const exactReferencePolicy = new Map([
  ["public.digital_order_items.digital_order_items_product_id_fkey[product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.held_cart_items.held_cart_items_product_id_fkey[product_id]", POLICY.STATE_DEPENDENT],
  ["public.inventory_lot_movements.inventory_lot_movements_product_id_fkey[product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.inventory_lots.inventory_lots_product_id_fkey[product_id]", POLICY.STATE_DEPENDENT],
  ["public.inventory_movements.inventory_movements_product_id_fkey[product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.inventory_stocks.inventory_stocks_product_id_fkey[product_id]", POLICY.TRANSFER_TO_CANONICAL],
  ["public.modifier_groups.modifier_groups_product_id_fkey[product_id]", POLICY.BLOCK_WHILE_ACTIVE],
  ["public.price_override_requests.price_override_requests_tenant_product_fkey[tenant_id,product_id]", POLICY.STATE_DEPENDENT],
  ["public.pricing_policy_operations.pricing_policy_operations_tenant_product_fkey[tenant_id,product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.pricing_policy_rules.pricing_policy_rules_tenant_product_fkey[tenant_id,product_id]", POLICY.BLOCK_WHILE_ACTIVE],
  ["public.product_barcode_conflicts.product_barcode_conflicts_candidate_fkey[tenant_id,candidate_product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.product_barcode_conflicts.product_barcode_conflicts_existing_fkey[tenant_id,conflicting_product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.product_barcode_operations.product_barcode_operations_product_fkey[tenant_id,product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.product_barcodes.product_barcodes_tenant_product_fkey[tenant_id,product_id]", POLICY.TRANSFER_TO_CANONICAL],
  ["public.product_complementaries.product_complementaries_complementary_id_fkey[complementary_id]", POLICY.BLOCK_WHILE_ACTIVE],
  ["public.product_complementaries.product_complementaries_product_id_fkey[product_id]", POLICY.BLOCK_WHILE_ACTIVE],
  ["public.product_components.product_components_component_product_id_fkey[component_product_id]", POLICY.BLOCK_WHILE_ACTIVE],
  ["public.product_components.product_components_parent_product_id_fkey[parent_product_id]", POLICY.BLOCK_WHILE_ACTIVE],
  ["public.product_financial_operations.product_financial_operations_tenant_product_fkey[tenant_id,product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.product_inventory_controls.product_inventory_controls_product_id_fkey[product_id]", POLICY.STATE_DEPENDENT],
  ["public.product_merge_aliases.product_merge_aliases_canonical_fkey[tenant_id,canonical_product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.product_merge_aliases.product_merge_aliases_source_fkey[tenant_id,source_product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.product_merge_operations.product_merge_operations_canonical_fkey[tenant_id,canonical_product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.product_merge_operations.product_merge_operations_source_fkey[tenant_id,source_product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.product_prices.product_prices_tenant_product_fkey[tenant_id,product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.production_consumptions.production_consumptions_product_id_fkey[product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.production_orders.production_orders_product_id_fkey[product_id]", POLICY.STATE_DEPENDENT],
  ["public.purchase_order_items.purchase_order_items_product_id_fkey[product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.sale_items.sale_items_product_id_fkey[product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.sale_return_items.sale_return_items_product_id_fkey[product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.sale_void_items.sale_void_items_product_id_fkey[product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.stocktake_items.stocktake_items_product_id_fkey[product_id]", POLICY.STATE_DEPENDENT],
  ["public.supplier_product_operations.supplier_product_operations_tenant_product_fkey[tenant_id,product_id]", POLICY.HISTORICAL_RETAIN],
  ["public.supplier_products.supplier_products_tenant_product_fkey[tenant_id,product_id]", POLICY.STATE_DEPENDENT],
]);

const manifestIds = new Set(manifest.map((row) => row.identity));
const unclassified = manifest.filter((row) => !exactReferencePolicy.has(row.identity));
const stalePolicy = [...exactReferencePolicy.keys()].filter((id) => !manifestIds.has(id));
const invalidClassifications = [...exactReferencePolicy.entries()].filter(([, classification]) => !Object.values(POLICY).includes(classification));

if (unclassified.length || stalePolicy.length || invalidClassifications.length) {
  throw new Error(
    `Product FK policy drift. unclassified=${JSON.stringify(unclassified)} ` +
    `stale=${JSON.stringify(stalePolicy)} invalid=${JSON.stringify(invalidClassifications)}`,
  );
}

const normalizedFunctionDefinition = (signature) => scalar(`
  SELECT regexp_replace(pg_get_functiondef('${signature}'::regprocedure), E'\\\\s+', ' ', 'g');
`).toLowerCase();

// The hardening migration deliberately wraps the original preview function: the
// private base retains the existing state-dependent blockers while the public
// wrapper adds newly classified live catalogue blockers. Audit both authoritative
// layers so refactoring the RPC does not create a false coverage failure.
const previewDefinition = [
  normalizedFunctionDefinition("public.preview_product_merge_v1(uuid,uuid,uuid)"),
  normalizedFunctionDefinition("public.preview_product_merge_base_v1(uuid,uuid,uuid)"),
].join(" ");
const mergeDefinition = normalizedFunctionDefinition("public.merge_duplicate_product_v1(uuid,uuid,uuid,text,text)");

const rowsByIdentity = new Map(manifest.map((row) => [row.identity, row]));
const tablesFor = (classification) => [...new Set(
  [...exactReferencePolicy.entries()]
    .filter(([, value]) => value === classification)
    .map(([id]) => rowsByIdentity.get(id)?.table)
    .filter(Boolean),
)];

// Any live/state-dependent relationship must participate in the server-side preview
// gate; otherwise a merge could strand live mutable state on an inactive source product.
const missingBlockerCoverage = [
  ...tablesFor(POLICY.BLOCK_WHILE_ACTIVE),
  ...tablesFor(POLICY.STATE_DEPENDENT),
].filter((table) => !previewDefinition.includes(table.toLowerCase()));

// Any mutable state declared transferable must participate in the authoritative merge.
const missingTransferCoverage = tablesFor(POLICY.TRANSFER_TO_CANONICAL)
  .filter((table) => !mergeDefinition.includes(table.toLowerCase()));

if (missingBlockerCoverage.length || missingTransferCoverage.length) {
  throw new Error(
    `Product merge policy is classified but not enforced. ` +
    `missing_blocker_coverage=${JSON.stringify(missingBlockerCoverage)} ` +
    `missing_transfer_coverage=${JSON.stringify(missingTransferCoverage)}`,
  );
}

const counts = Object.fromEntries(Object.values(POLICY).map((classification) => [
  classification,
  [...exactReferencePolicy.values()].filter((value) => value === classification).length,
]));
process.stdout.write(`PRODUCT_FK_POLICY=${JSON.stringify({ counts, references: Object.fromEntries(exactReferencePolicy) })}\n`);