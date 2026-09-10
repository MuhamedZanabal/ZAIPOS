import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "17000000-0000-0000-0000-000000000111",
  tenantB: "17000000-0000-0000-0000-000000000112",
  branchA: "27000000-0000-0000-0000-000000000111",
  branchB: "27000000-0000-0000-0000-000000000112",
  centerA: "37000000-0000-0000-0000-000000000111",
  managerA: "47000000-0000-0000-0000-000000000111",
  branchManagerA: "47000000-0000-0000-0000-000000000112",
  cashierA: "47000000-0000-0000-0000-000000000113",
  managerB: "47000000-0000-0000-0000-000000000114",
  source: "57000000-0000-0000-0000-000000000111",
  target: "57000000-0000-0000-0000-000000000112",
  third: "57000000-0000-0000-0000-000000000113",
  otherTenantProduct: "57000000-0000-0000-0000-000000000114",
  heldCart: "67000000-0000-0000-0000-000000000111",
  heldItem: "67000000-0000-0000-0000-000000000112",
  production: "77000000-0000-0000-0000-000000000111",
  override: "87000000-0000-0000-0000-000000000111",
};

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}
function sql(statement) { return psql(["-c", statement], false); }
function scalar(statement) { return psql(["-Atq", "-c", statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ""; }
function asUser(userId, statement) {
  return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertIncludes(label, actual, expected) {
  if (!actual.includes(expected)) throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
}
function expectReject(label, userId, statement, pattern = /forbidden|permission|tenant|blocked|active|duplicate|canonical|operation/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

assertEqual("merge alias ledger exists", scalar("SELECT to_regclass('public.product_merge_aliases') IS NOT NULL;"), "t");
assertEqual("merge operation ledger exists", scalar("SELECT to_regclass('public.product_merge_operations') IS NOT NULL;"), "t");
for (const signature of [
  "public.resolve_canonical_product_id_v1(uuid,uuid)",
  "public.preview_product_merge_v1(uuid,uuid,uuid)",
  "public.merge_duplicate_product_v1(uuid,uuid,uuid,text,text)",
]) {
  assertEqual(`required function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','merge-manager-a@zaipos.test','{}'),
    ('${I.branchManagerA}','merge-branch-manager-a@zaipos.test','{}'),
    ('${I.cashierA}','merge-cashier-a@zaipos.test','{}'),
    ('${I.managerB}','merge-manager-b@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Merge Tenant A','merge-tenant-a','BHD',10,false),
    ('${I.tenantB}','Merge Tenant B','merge-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Merge Branch A','active'),
    ('${I.branchB}','${I.tenantB}','Merge Branch B','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES
    ('${I.centerA}','${I.tenantA}','${I.branchA}','Merge Main Stock','warehouse','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}',NULL,'manager'),
    ('${I.branchManagerA}','${I.tenantA}','${I.branchA}','manager'),
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.managerB}','${I.tenantB}',NULL,'manager')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.products(id,tenant_id,name,product_type,sku,price,cost,tax_rate,status,barcode) VALUES
    ('${I.source}','${I.tenantA}','Duplicate Cola 330ml','simple','DUP-COLA',1.000,0.600,10,'active',NULL),
    ('${I.target}','${I.tenantA}','Cola 330ml','simple','COLA-330',1.100,0.650,10,'active',NULL),
    ('${I.third}','${I.tenantA}','Third Product','simple','THIRD',2.000,1.000,10,'active',NULL),
    ('${I.otherTenantProduct}','${I.tenantB}','Other Tenant Cola','simple','OTHER-COLA',1.000,0.600,10,'active',NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.source}',5.000),
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.target}',2.000)
  ON CONFLICT (inventory_center_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity;
`);

const barcodePayload = (rows) => JSON.stringify(rows).replaceAll("'", "''");
assertEqual(
  "source barcode fixture",
  asUser(I.managerA, `SELECT public.replace_product_barcodes_v1('${I.tenantA}'::uuid,'${I.source}'::uuid,'${barcodePayload([
    { barcode: "DUP-COLA-PRIMARY", barcode_type: "internal", is_primary: true },
    { barcode: "DUP-COLA-CASE", barcode_type: "supplier", is_primary: false },
  ])}'::jsonb,'merge-source-barcodes-111')::text;`),
  I.source,
);
assertEqual(
  "target barcode fixture",
  asUser(I.managerA, `SELECT public.replace_product_barcodes_v1('${I.tenantA}'::uuid,'${I.target}'::uuid,'${barcodePayload([
    { barcode: "COLA-330-PRIMARY", barcode_type: "internal", is_primary: true },
  ])}'::jsonb,'merge-target-barcodes-111')::text;`),
  I.target,
);

// Historical inventory evidence is deliberately attached to the duplicate source.
// The merge may create compensating stock-transfer evidence, but this row must never
// be rewritten to the canonical product.
const historicalMovement = scalar(`
  INSERT INTO public.inventory_movements(
    tenant_id,branch_id,inventory_center_id,product_id,movement_type,quantity,reason,reference_type,user_id
  ) VALUES (
    '${I.tenantA}','${I.branchA}','${I.centerA}','${I.source}','purchase',5.000,
    'Historical duplicate receipt','product_merge_test','${I.managerA}'
  ) RETURNING id::text;
`);

const preview = () => JSON.parse(asUser(
  I.managerA,
  `SELECT public.preview_product_merge_v1('${I.tenantA}'::uuid,'${I.source}'::uuid,'${I.target}'::uuid)::text;`,
));
const merge = (operation = "duplicate-merge-operation-111", target = I.target) =>
  `SELECT public.merge_duplicate_product_v1('${I.tenantA}'::uuid,'${I.source}'::uuid,'${target}'::uuid,'Verified duplicate catalogue record','${operation}')::text;`;

expectReject("cashier cannot merge products", I.cashierA, merge("duplicate-merge-cashier-111"));
expectReject("branch-scoped manager cannot merge tenant-global products", I.branchManagerA, merge("duplicate-merge-branch-manager-111"));
expectReject("cross-tenant manager cannot merge products", I.managerB, merge("duplicate-merge-cross-tenant-111"));
expectReject(
  "cross-tenant canonical target rejected",
  I.managerA,
  merge("duplicate-merge-cross-target-111", I.otherTenantProduct),
  /tenant|canonical|product/i,
);
expectReject(
  "self merge rejected",
  I.managerA,
  `SELECT public.merge_duplicate_product_v1('${I.tenantA}'::uuid,'${I.source}'::uuid,'${I.source}'::uuid,'Invalid self merge','duplicate-merge-self-111')::text;`,
  /same|self|canonical|different/i,
);

// An unresolved held cart is a live transaction snapshot. Catalogue merge must block
// rather than silently changing what will later be resumed and sold.
sql(`
  INSERT INTO public.held_carts(
    id,tenant_id,branch_id,created_by,label,channel,status,client_operation_id,request_payload
  ) VALUES (
    '${I.heldCart}','${I.tenantA}','${I.branchA}','${I.cashierA}','Duplicate merge blocker','physical_pos','held',
    'duplicate-held-cart-111','{}'::jsonb
  );
  INSERT INTO public.held_cart_items(
    id,tenant_id,branch_id,held_cart_id,line_id,product_id,product_name_snapshot,product_type_snapshot,
    quantity,expected_unit_price_fils,discount_fils,tax_rate_snapshot,modifiers
  ) VALUES (
    '${I.heldItem}','${I.tenantA}','${I.branchA}','${I.heldCart}','line-source','${I.source}',
    'Duplicate Cola 330ml','simple',1.000,1000,0,10,'[]'::jsonb
  );
`);
let blockedPreview = preview();
assertEqual("held cart makes preview unsafe", String(blockedPreview.can_merge), "false");
assertIncludes("held cart blocker reported", JSON.stringify(blockedPreview.blockers), "held_cart");
expectReject("held cart blocks merge", I.managerA, merge("duplicate-merge-held-block-111"), /blocked|held cart/i);
sql(`UPDATE public.held_carts SET status='discarded',resolved_by='${I.managerA}',resolution_operation_id='duplicate-held-discard-111',resolution_payload='{}'::jsonb,resolved_result='{}'::jsonb,resolved_at=now() WHERE id='${I.heldCart}';`);

// Draft/in-progress production refers to a mutable future inventory effect and must
// be resolved before the catalogue identity is retired.
sql(`
  INSERT INTO public.production_orders(
    id,tenant_id,branch_id,product_id,user_id,planned_quantity,status,notes
  ) VALUES (
    '${I.production}','${I.tenantA}','${I.branchA}','${I.source}','${I.managerA}',1.000,'draft','duplicate merge blocker'
  );
`);
blockedPreview = preview();
assertEqual("open production makes preview unsafe", String(blockedPreview.can_merge), "false");
assertIncludes("production blocker reported", JSON.stringify(blockedPreview.blockers), "production");
expectReject("open production blocks merge", I.managerA, merge("duplicate-merge-production-block-111"), /blocked|production/i);
sql(`UPDATE public.production_orders SET status='cancelled' WHERE id='${I.production}';`);

// Pending/approved price overrides encode a product-specific future sale decision.
sql(`
  INSERT INTO public.price_override_requests(
    id,tenant_id,branch_id,product_id,requested_by,channel,quantity,
    original_unit_price_fils,requested_unit_price_fils,request_reason,status,
    request_client_mutation_id,expires_at
  ) VALUES (
    '${I.override}','${I.tenantA}','${I.branchA}','${I.source}','${I.cashierA}','physical_pos',1.000,
    1000,900,'duplicate merge blocker','pending','duplicate-price-override-111',now()+interval '15 minutes'
  );
`);
blockedPreview = preview();
assertEqual("pending price override makes preview unsafe", String(blockedPreview.can_merge), "false");
assertIncludes("price override blocker reported", JSON.stringify(blockedPreview.blockers), "price_override");
expectReject("pending price override blocks merge", I.managerA, merge("duplicate-merge-override-block-111"), /blocked|price override/i);
sql(`UPDATE public.price_override_requests SET status='expired' WHERE id='${I.override}';`);

const readyPreview = preview();
assertEqual("cleared merge preview is safe", String(readyPreview.can_merge), "true");
assertEqual("preview source stock", String(readyPreview.source_stock_quantity), "5.000");
assertEqual("preview target stock", String(readyPreview.canonical_stock_quantity), "2.000");
assertEqual("preview combined stock", String(readyPreview.combined_stock_quantity), "7.000");
assertEqual("preview source barcode count", String(readyPreview.source_barcode_count), "2");

const mergeResult = JSON.parse(asUser(I.managerA, merge()));
assertEqual("merge returns canonical product", mergeResult.canonical_product_id, I.target);
assertEqual("merge returns retired source", mergeResult.source_product_id, I.source);
assertEqual("canonical resolver follows alias", asUser(I.managerA, `SELECT public.resolve_canonical_product_id_v1('${I.tenantA}'::uuid,'${I.source}'::uuid)::text;`), I.target);
assertEqual("canonical resolver is stable for target", asUser(I.managerA, `SELECT public.resolve_canonical_product_id_v1('${I.tenantA}'::uuid,'${I.target}'::uuid)::text;`), I.target);
assertEqual("source retired", scalar(`SELECT status::text FROM public.products WHERE id='${I.source}'::uuid;`), "inactive");
assertEqual("canonical stays active", scalar(`SELECT status::text FROM public.products WHERE id='${I.target}'::uuid;`), "active");

assertEqual("all source barcodes moved", scalar(`SELECT count(*)::text FROM public.product_barcodes WHERE product_id='${I.source}'::uuid;`), "0");
assertEqual("canonical owns all three barcodes", scalar(`SELECT count(*)::text FROM public.product_barcodes WHERE product_id='${I.target}'::uuid;`), "3");
assertEqual("canonical has exactly one primary", scalar(`SELECT count(*)::text FROM public.product_barcodes WHERE product_id='${I.target}'::uuid AND is_primary;`), "1");
assertEqual("existing canonical primary wins", scalar(`SELECT barcode FROM public.product_barcodes WHERE product_id='${I.target}'::uuid AND is_primary;`), "COLA-330-PRIMARY");
assertEqual("moved alias resolves to canonical", asUser(I.cashierA, `SELECT public.resolve_product_by_barcode_v1('${I.tenantA}'::uuid,'DUP-COLA-CASE')::text;`), I.target);

assertEqual("source stock transferred to zero", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.centerA}'::uuid AND product_id='${I.source}'::uuid;`), "0.000");
assertEqual("canonical stock is exact sum", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.centerA}'::uuid AND product_id='${I.target}'::uuid;`), "7.000");
assertEqual("historical inventory movement keeps source product", scalar(`SELECT product_id::text FROM public.inventory_movements WHERE id='${historicalMovement}'::uuid;`), I.source);
assertEqual("stock transfer produces two adjustment movements", scalar(`SELECT count(*)::text FROM public.inventory_movements WHERE reference_type='product_merge' AND reference_id=(SELECT id FROM public.product_merge_operations WHERE tenant_id='${I.tenantA}'::uuid AND operation_id='duplicate-merge-operation-111');`), "2");
assertEqual("stock transfer signed quantity nets zero", scalar(`SELECT COALESCE(sum(quantity),0)::text FROM public.inventory_movements WHERE reference_type='product_merge' AND reference_id=(SELECT id FROM public.product_merge_operations WHERE tenant_id='${I.tenantA}'::uuid AND operation_id='duplicate-merge-operation-111');`), "0.000");

assertEqual("merge audit exactly once", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='catalogue.product_merged' AND entity_id='${I.source}'::uuid;`), "1");
assertEqual("merge operation exactly once", scalar(`SELECT count(*)::text FROM public.product_merge_operations WHERE tenant_id='${I.tenantA}'::uuid AND operation_id='duplicate-merge-operation-111';`), "1");
assertEqual("merge replay stable", asUser(I.managerA, merge()), JSON.stringify(mergeResult));
expectReject(
  "operation ID cannot be reused with another canonical target",
  I.managerA,
  merge("duplicate-merge-operation-111", I.third),
  /operation.*different|different input/i,
);
expectReject(
  "already merged source cannot be merged again under new operation",
  I.managerA,
  merge("duplicate-merge-second-attempt-111", I.third),
  /already merged|inactive|canonical/i,
);

assertEqual("source alias row stored once", scalar(`SELECT count(*)::text FROM public.product_merge_aliases WHERE tenant_id='${I.tenantA}'::uuid AND source_product_id='${I.source}'::uuid AND canonical_product_id='${I.target}'::uuid;`), "1");
assertEqual("other tenant cannot resolve tenant A source", asUser(I.managerB, `SELECT public.resolve_canonical_product_id_v1('${I.tenantB}'::uuid,'${I.source}'::uuid) IS NULL;`), "t");
for (const table of ["product_merge_aliases", "product_merge_operations"]) {
  for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
    assertEqual(`${table} authenticated ${privilege}`, scalar(`SELECT has_table_privilege('authenticated','public.${table}','${privilege}');`), "f");
  }
}

process.stdout.write("Duplicate product merge PASS: tenant-global authorization, live-workflow blocking, exact stock transfer, barcode canonicalization, immutable history, idempotency, audit and direct-write lockdown hold.\n");
