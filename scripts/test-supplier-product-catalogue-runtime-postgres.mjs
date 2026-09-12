import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "1c000000-0000-0000-0000-000000000111",
  tenantB: "1c000000-0000-0000-0000-000000000112",
  branchA: "2c000000-0000-0000-0000-000000000111",
  branchB: "2c000000-0000-0000-0000-000000000112",
  managerA: "4c000000-0000-0000-0000-000000000111",
  inventoryA: "4c000000-0000-0000-0000-000000000112",
  cashierA: "4c000000-0000-0000-0000-000000000113",
  managerB: "4c000000-0000-0000-0000-000000000114",
  productA: "5c000000-0000-0000-0000-000000000111",
  productB: "5c000000-0000-0000-0000-000000000112",
  productOtherTenant: "5c000000-0000-0000-0000-000000000113",
  supplierA: "6c000000-0000-0000-0000-000000000111",
  supplierB: "6c000000-0000-0000-0000-000000000112",
  supplierOtherTenant: "6c000000-0000-0000-0000-000000000113",
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
function expectReject(label, userId, statement, pattern = /forbidden|permission|tenant|branch|supplier|product|operation|sku|preferred|authenticated/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','catalogue-manager-a@zaipos.test','{}'),
    ('${I.inventoryA}','catalogue-inventory-a@zaipos.test','{}'),
    ('${I.cashierA}','catalogue-cashier-a@zaipos.test','{}'),
    ('${I.managerB}','catalogue-manager-b@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Catalogue Tenant A','catalogue-tenant-a','BHD',10,false),
    ('${I.tenantB}','Catalogue Tenant B','catalogue-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Catalogue Branch A','active'),
    ('${I.branchB}','${I.tenantB}','Catalogue Branch B','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}','${I.branchA}','manager'),
    ('${I.inventoryA}','${I.tenantA}','${I.branchA}','inventory'),
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.managerB}','${I.tenantB}','${I.branchB}','manager')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status,barcode) VALUES
    ('${I.productA}','${I.tenantA}','Catalogue Water 500ml','simple',0.300,0.150,0,'active',NULL),
    ('${I.productB}','${I.tenantA}','Catalogue Water 1.5L','simple',0.500,0.250,0,'active',NULL),
    ('${I.productOtherTenant}','${I.tenantB}','Other Tenant Water','simple',0.300,0.150,0,'active',NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.suppliers(id,tenant_id,name,status) VALUES
    ('${I.supplierA}','${I.tenantA}','Catalogue Supplier A','active'),
    ('${I.supplierB}','${I.tenantA}','Catalogue Supplier B','active'),
    ('${I.supplierOtherTenant}','${I.tenantB}','Other Tenant Supplier','active')
  ON CONFLICT (id) DO NOTHING;
`);

const upsert = ({ supplier = I.supplierA, product = I.productA, sku = "SUP-WATER-500", name = "Supplier Water 500ml", pack = 12000, cost = 151, lead = 2, preferred = true, status = "active", operation = "supplier-product-op-111" } = {}) =>
  `SELECT public.upsert_supplier_product_v1('${I.tenantA}','${I.branchA}','${supplier}','${product}','${sku}','${name}',${pack}::bigint,${cost}::bigint,${lead},${preferred},'${status}','${operation}')::text;`;

const rowId = asUser(I.managerA, upsert());
assertEqual("exact replay returns same row", asUser(I.managerA, upsert()), rowId);
assertEqual("exact fils retained", scalar(`SELECT current_cost_fils::text FROM public.supplier_products WHERE id='${rowId}'::uuid;`), "151");
assertEqual("pack milli-units retained", scalar(`SELECT pack_quantity_milli::text FROM public.supplier_products WHERE id='${rowId}'::uuid;`), "12000");
assertEqual("supplier sku normalized", scalar(`SELECT supplier_sku FROM public.supplier_products WHERE id='${rowId}'::uuid;`), "SUP-WATER-500");
assertEqual("preferred flag retained", scalar(`SELECT is_preferred::text FROM public.supplier_products WHERE id='${rowId}'::uuid;`), "true");
assertEqual("operation evidence exactly once", scalar(`SELECT count(*)::text FROM public.supplier_product_operations WHERE tenant_id='${I.tenantA}' AND operation_id='supplier-product-op-111';`), "1");
expectReject("operation payload mismatch", I.managerA, upsert({ cost: 152 }));

const inventoryRow = asUser(I.inventoryA, upsert({ supplier: I.supplierB, sku: "SUPB-WATER-500", cost: 149, preferred: false, operation: "supplier-product-op-112" }));
assertEqual("inventory role may maintain procurement catalogue", scalar(`SELECT count(*)::text FROM public.supplier_products WHERE id='${inventoryRow}'::uuid;`), "1");
expectReject("cashier cannot maintain supplier catalogue", I.cashierA, upsert({ operation: "supplier-product-op-113" }));
expectReject("other tenant manager cannot maintain branch catalogue", I.managerB, upsert({ operation: "supplier-product-op-114" }));
expectReject("cross tenant supplier rejected", I.managerA, upsert({ supplier: I.supplierOtherTenant, operation: "supplier-product-op-115" }));
expectReject("cross tenant product rejected", I.managerA, upsert({ product: I.productOtherTenant, operation: "supplier-product-op-116" }));
expectReject("nonpositive pack rejected", I.managerA, upsert({ pack: 0, operation: "supplier-product-op-117" }));
expectReject("negative exact-fils cost rejected", I.managerA, upsert({ cost: -1, operation: "supplier-product-op-118" }));

expectReject(
  "supplier sku collision is blocked",
  I.managerA,
  upsert({ product: I.productB, sku: " sup-water-500 ", preferred: false, operation: "supplier-product-op-119" }),
  /sku|duplicate|unique/i,
);

const preferredB = asUser(I.managerA, upsert({ supplier: I.supplierB, product: I.productA, sku: "SUPB-WATER-500", cost: 148, preferred: true, operation: "supplier-product-op-120" }));
assertEqual("new preferred supplier selected", scalar(`SELECT is_preferred::text FROM public.supplier_products WHERE id='${preferredB}'::uuid;`), "true");
assertEqual("old preferred supplier cleared atomically", scalar(`SELECT is_preferred::text FROM public.supplier_products WHERE id='${rowId}'::uuid;`), "false");
assertEqual("one active preferred supplier per branch product", scalar(`SELECT count(*)::text FROM public.supplier_products WHERE tenant_id='${I.tenantA}' AND branch_id='${I.branchA}' AND product_id='${I.productA}' AND status='active' AND is_preferred;`), "1");

const listed = JSON.parse(asUser(I.inventoryA, `SELECT COALESCE(json_agg(json_build_object('supplier_id',supplier_id,'product_id',product_id,'current_cost_fils',current_cost_fils,'is_preferred',is_preferred) ORDER BY supplier_id),'[]'::json)::text FROM public.list_supplier_products_v1('${I.tenantA}','${I.branchA}',NULL)`));
assertEqual("branch list returns maintained mappings", String(listed.length), "2");
expectReject("cashier cannot list supplier catalogue", I.cashierA, `SELECT count(*) FROM public.list_supplier_products_v1('${I.tenantA}','${I.branchA}',NULL)`);
expectReject("wrong tenant branch list rejected", I.managerA, `SELECT count(*) FROM public.list_supplier_products_v1('${I.tenantA}','${I.branchB}',NULL)`);

expectReject(
  "authenticated direct update denied",
  I.managerA,
  `UPDATE public.supplier_products SET current_cost_fils=1 WHERE id='${rowId}'::uuid`,
  /permission|denied/i,
);
expectReject(
  "authenticated operation ledger insert denied",
  I.managerA,
  `INSERT INTO public.supplier_product_operations(tenant_id,branch_id,supplier_id,product_id,operation_id,request_hash,request_payload,actor_id) VALUES('${I.tenantA}','${I.branchA}','${I.supplierA}','${I.productA}','supplier-direct-op-111','x','{}','${I.managerA}')`,
  /permission|denied/i,
);

assertEqual("catalogue audit emitted", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='supplier.product_catalogue_upserted' AND entity_id='${preferredB}'::uuid;`), "1");
console.log("Supplier product catalogue runtime contract passed.");
