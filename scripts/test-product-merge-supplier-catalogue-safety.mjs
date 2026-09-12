import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenant: "1d000000-0000-0000-0000-000000000111",
  branch: "2d000000-0000-0000-0000-000000000111",
  manager: "4d000000-0000-0000-0000-000000000111",
  source: "5d000000-0000-0000-0000-000000000111",
  target: "5d000000-0000-0000-0000-000000000112",
  supplier: "6d000000-0000-0000-0000-000000000111",
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
function expectReject(label, userId, statement, pattern = /blocked|supplier|active|duplicate|merge/i) {
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
    ('${I.manager}','supplier-merge-manager@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenant}','Supplier Merge Tenant','supplier-merge-tenant','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branch}','${I.tenant}','Supplier Merge Branch','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.manager}','${I.tenant}',NULL,'manager')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.products(id,tenant_id,name,product_type,sku,price,cost,tax_rate,status,barcode) VALUES
    ('${I.source}','${I.tenant}','Supplier Duplicate Product','simple','SUP-MERGE-SOURCE',1.000,0.500,10,'active',NULL),
    ('${I.target}','${I.tenant}','Supplier Canonical Product','simple','SUP-MERGE-TARGET',1.000,0.500,10,'active',NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.suppliers(id,tenant_id,name,status) VALUES
    ('${I.supplier}','${I.tenant}','Supplier Merge Vendor','active')
  ON CONFLICT (id) DO NOTHING;
`);

const upsert = (status, operation) => `
  SELECT public.upsert_supplier_product_v1(
    '${I.tenant}'::uuid,
    '${I.branch}'::uuid,
    '${I.supplier}'::uuid,
    '${I.source}'::uuid,
    'SUP-MERGE-SKU',
    'Supplier Duplicate Product',
    1000::bigint,
    500::bigint,
    1,
    false,
    '${status}',
    '${operation}'
  )::text;
`;
const preview = () => JSON.parse(asUser(
  I.manager,
  `SELECT public.preview_product_merge_v1('${I.tenant}'::uuid,'${I.source}'::uuid,'${I.target}'::uuid)::text;`,
));
const merge = (operation) => `
  SELECT public.merge_duplicate_product_v1(
    '${I.tenant}'::uuid,
    '${I.source}'::uuid,
    '${I.target}'::uuid,
    'Supplier catalogue duplicate merge test',
    '${operation}'
  )::text;
`;

const supplierProductId = asUser(I.manager, upsert('active', 'supplier-merge-catalogue-active-111'));
let state = preview();
assertEqual('active supplier mapping makes preview unsafe', String(state.can_merge), 'false');
assertIncludes('supplier mapping blocker reported', JSON.stringify(state.blockers), 'supplier_products');
expectReject('active supplier mapping blocks merge', I.manager, merge('supplier-merge-blocked-111'));

assertEqual(
  'same supplier mapping becomes inactive',
  asUser(I.manager, upsert('inactive', 'supplier-merge-catalogue-inactive-111')),
  supplierProductId,
);
state = preview();
assertEqual('inactive supplier mapping permits merge', String(state.can_merge), 'true');

const result = JSON.parse(asUser(I.manager, merge('supplier-merge-complete-111')));
assertEqual('merge returns canonical product', result.canonical_product_id, I.target);
assertEqual('source product retired', scalar(`SELECT status FROM public.products WHERE id='${I.source}'::uuid;`), 'inactive');
assertEqual(
  'inactive supplier mapping retains historical source identity',
  scalar(`SELECT product_id::text FROM public.supplier_products WHERE id='${supplierProductId}'::uuid;`),
  I.source,
);
assertEqual(
  'supplier catalogue operation history retains source identity',
  scalar(`SELECT count(*)::text FROM public.supplier_product_operations WHERE tenant_id='${I.tenant}'::uuid AND product_id='${I.source}'::uuid;`),
  '2',
);

console.log('Supplier catalogue duplicate-product merge safety contract passed.');
