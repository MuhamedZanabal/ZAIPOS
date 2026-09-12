import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "1a000000-0000-0000-0000-000000000111",
  tenantB: "1a000000-0000-0000-0000-000000000112",
  branchA: "2a000000-0000-0000-0000-000000000111",
  branchB: "2a000000-0000-0000-0000-000000000112",
  centerA: "3a000000-0000-0000-0000-000000000111",
  managerA: "4a000000-0000-0000-0000-000000000111",
  cashierA: "4a000000-0000-0000-0000-000000000112",
  productBranchCost: "5a000000-0000-0000-0000-000000000111",
  productBaseCost: "5a000000-0000-0000-0000-000000000112",
  productMissingCost: "5a000000-0000-0000-0000-000000000113",
  productRounded: "5a000000-0000-0000-0000-000000000114",
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
function assertDeepEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
function expectReject(label, userId, statement, pattern = /forbidden|authenticated|branch|tenant/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

assertEqual(
  "detail valuation function exists",
  scalar("SELECT to_regprocedure('public.get_inventory_current_cost_valuation_v1(uuid,uuid,uuid)') IS NOT NULL;"),
  "t",
);
assertEqual(
  "summary valuation function exists",
  scalar("SELECT to_regprocedure('public.get_inventory_current_cost_valuation_summary_v1(uuid,uuid,uuid)') IS NOT NULL;"),
  "t",
);

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','valuation-manager-a@zaipos.test','{}'),
    ('${I.cashierA}','valuation-cashier-a@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Valuation Tenant A','valuation-tenant-a','BHD',10,false),
    ('${I.tenantB}','Valuation Tenant B','valuation-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Valuation Branch A','active'),
    ('${I.branchB}','${I.tenantB}','Valuation Branch B','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES
    ('${I.centerA}','${I.tenantA}','${I.branchA}','Valuation Main Stock','warehouse','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}','${I.branchA}','manager'),
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.products(id,tenant_id,name,product_type,sku,price,cost,tax_rate,status,barcode) VALUES
    ('${I.productBranchCost}','Branch Cost Product','simple','VAL-BRANCH',1.000,0.500,10,'active',NULL),
    ('${I.productBaseCost}','Base Cost Product','simple','VAL-BASE',1.000,0.333,10,'active',NULL),
    ('${I.productMissingCost}','Missing Cost Product','simple','VAL-MISSING',1.000,0.000,10,'active',NULL),
    ('${I.productRounded}','Rounded Product','simple','VAL-ROUND',1.000,0.100,10,'active',NULL)
  ON CONFLICT (id) DO NOTHING;
` .replaceAll(`('${I.productBranchCost}','Branch`, `('${I.productBranchCost}','${I.tenantA}','Branch`)
  .replaceAll(`('${I.productBaseCost}','Base`, `('${I.productBaseCost}','${I.tenantA}','Base`)
  .replaceAll(`('${I.productMissingCost}','Missing`, `('${I.productMissingCost}','${I.tenantA}','Missing`)
  .replaceAll(`('${I.productRounded}','Rounded`, `('${I.productRounded}','${I.tenantA}','Rounded`));

sql(`
  DELETE FROM public.product_prices
  WHERE tenant_id='${I.tenantA}' AND product_id IN (
    '${I.productBranchCost}','${I.productBaseCost}','${I.productMissingCost}','${I.productRounded}'
  );

  INSERT INTO public.product_prices(tenant_id,product_id,branch_id,price_type,amount_fils,effective_from,reason,source) VALUES
    ('${I.tenantA}','${I.productBranchCost}',NULL,'cost',500,now() - interval '2 hours','Base valuation test cost','manual'),
    ('${I.tenantA}','${I.productBranchCost}','${I.branchA}','cost',600,now() - interval '1 hour','Branch valuation test cost','manual'),
    ('${I.tenantA}','${I.productBaseCost}',NULL,'cost',333,now() - interval '1 hour','Base valuation fallback cost','manual'),
    ('${I.tenantA}','${I.productRounded}',NULL,'cost',100,now() - interval '1 hour','Exact rounding test cost','manual');

  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.productBranchCost}',1.250),
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.productBaseCost}',2.000),
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.productMissingCost}',1.000),
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.productRounded}',0.333)
  ON CONFLICT(inventory_center_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity;
`);

const rows = JSON.parse(asUser(I.managerA, `
  SELECT COALESCE(json_agg(json_build_object(
    'product_id', product_id,
    'quantity', quantity::text,
    'quantity_milliunits', quantity_milliunits,
    'unit_cost_fils', unit_cost_fils,
    'cost_source', cost_source,
    'value_millifils', value_millifils,
    'value_fils', value_fils,
    'coverage_status', coverage_status
  ) ORDER BY product_id), '[]'::json)::text
  FROM public.get_inventory_current_cost_valuation_v1('${I.tenantA}','${I.branchA}','${I.centerA}')
`));

const byProduct = new Map(rows.map((row) => [row.product_id, row]));
assertDeepEqual("branch cost overrides base", byProduct.get(I.productBranchCost), {
  product_id: I.productBranchCost,
  quantity: "1.250",
  quantity_milliunits: 1250,
  unit_cost_fils: 600,
  cost_source: "current_branch_cost",
  value_millifils: 750000,
  value_fils: 750,
  coverage_status: "valued",
});
assertDeepEqual("base cost fallback", byProduct.get(I.productBaseCost), {
  product_id: I.productBaseCost,
  quantity: "2.000",
  quantity_milliunits: 2000,
  unit_cost_fils: 333,
  cost_source: "current_base_cost",
  value_millifils: 666000,
  value_fils: 666,
  coverage_status: "valued",
});
assertDeepEqual("missing cost is explicit", byProduct.get(I.productMissingCost), {
  product_id: I.productMissingCost,
  quantity: "1.000",
  quantity_milliunits: 1000,
  unit_cost_fils: null,
  cost_source: "missing_cost",
  value_millifils: null,
  value_fils: null,
  coverage_status: "missing_cost",
});
assertDeepEqual("fractional quantity rounds once at fils boundary", byProduct.get(I.productRounded), {
  product_id: I.productRounded,
  quantity: "0.333",
  quantity_milliunits: 333,
  unit_cost_fils: 100,
  cost_source: "current_base_cost",
  value_millifils: 33300,
  value_fils: 33,
  coverage_status: "valued",
});

const summary = JSON.parse(asUser(I.managerA, `
  SELECT public.get_inventory_current_cost_valuation_summary_v1('${I.tenantA}','${I.branchA}','${I.centerA}')::text
`));
assertEqual("summary method", summary.valuation_method, "current_cost");
assertEqual("summary exact millifils", String(summary.total_value_millifils), "1449300");
assertEqual("summary rounded fils", String(summary.total_value_fils), "1449");
assertEqual("summary valued positions", String(summary.valued_positions), "3");
assertEqual("summary missing positions", String(summary.missing_cost_positions), "1");
assertEqual("summary coverage", summary.coverage_status, "incomplete");

expectReject(
  "cashier cannot read monetary valuation",
  I.cashierA,
  `SELECT count(*) FROM public.get_inventory_current_cost_valuation_v1('${I.tenantA}','${I.branchA}','${I.centerA}')`,
);
expectReject(
  "cross-tenant branch scope is rejected",
  I.managerA,
  `SELECT count(*) FROM public.get_inventory_current_cost_valuation_v1('${I.tenantA}','${I.branchB}',NULL)`,
);
expectReject(
  "cross-scope inventory center is rejected",
  I.managerA,
  `SELECT count(*) FROM public.get_inventory_current_cost_valuation_v1('${I.tenantA}','${I.branchA}','00000000-0000-0000-0000-000000000001')`,
  /center|branch|tenant/i,
);

console.log("Inventory current-cost valuation runtime contract passed.");
