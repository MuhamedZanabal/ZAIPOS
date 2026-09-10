import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "18000000-0000-0000-0000-000000000131",
  tenantB: "18000000-0000-0000-0000-000000000132",
  branchA: "28000000-0000-0000-0000-000000000131",
  branchA2: "28000000-0000-0000-0000-000000000132",
  branchB: "28000000-0000-0000-0000-000000000133",
  tenantManagerA: "38000000-0000-0000-0000-000000000131",
  branchManagerA: "38000000-0000-0000-0000-000000000132",
  cashierA: "38000000-0000-0000-0000-000000000133",
  managerB: "38000000-0000-0000-0000-000000000134",
  categoryA: "48000000-0000-0000-0000-000000000131",
  categoryB: "48000000-0000-0000-0000-000000000132",
  productA: "58000000-0000-0000-0000-000000000131",
  productB: "58000000-0000-0000-0000-000000000132",
};

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}
function sql(statement) { return psql(["-c", statement], false); }
function scalar(statement) {
  return psql(["-Atq", "-c", statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}
function asUser(userId, statement) {
  return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`);
}
function jsonAsUser(userId, statement) {
  return JSON.parse(asUser(userId, `${statement}::text`));
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assert(condition, label) {
  if (!condition) throw new Error(label);
}
function expectReject(label, userId, statement, pattern = /forbidden|permission|tenant|branch|stale|operation|reason/i) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

assertEqual("pricing rule ledger exists", scalar("SELECT to_regclass('public.pricing_policy_rules') IS NOT NULL;"), "t");
assertEqual("pricing operation ledger exists", scalar("SELECT to_regclass('public.pricing_policy_operations') IS NOT NULL;"), "t");
for (const signature of [
  "public.set_pricing_policy_rule_v1(uuid,uuid,uuid,uuid,integer,bigint,text,text,text)",
  "public.deactivate_pricing_policy_rule_v1(uuid,uuid,text,text)",
  "public.preview_product_pricing_v1(uuid,uuid,uuid,public.sales_channel)",
  "public.apply_product_pricing_policy_v1(uuid,uuid,uuid,public.sales_channel,bigint,text,text)",
]) {
  assertEqual(`required function ${signature}`, scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.tenantManagerA}','pricing-tenant-manager-a@zaipos.test','{}'),
    ('${I.branchManagerA}','pricing-branch-manager-a@zaipos.test','{}'),
    ('${I.cashierA}','pricing-cashier-a@zaipos.test','{}'),
    ('${I.managerB}','pricing-manager-b@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Pricing Tenant A','pricing-tenant-a','BHD',10,false),
    ('${I.tenantB}','Pricing Tenant B','pricing-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Pricing Branch A','active'),
    ('${I.branchA2}','${I.tenantA}','Pricing Branch A2','active'),
    ('${I.branchB}','${I.tenantB}','Pricing Branch B','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.tenantManagerA}','${I.tenantA}',NULL,'manager'),
    ('${I.branchManagerA}','${I.tenantA}','${I.branchA}','manager'),
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.managerB}','${I.tenantB}','${I.branchB}','manager')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.categories(id,tenant_id,name,status) VALUES
    ('${I.categoryA}','${I.tenantA}','Pricing Category A','active'),
    ('${I.categoryB}','${I.tenantB}','Pricing Category B','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.products(id,tenant_id,category_id,name,product_type,price,cost,tax_rate,status) VALUES
    ('${I.productA}','${I.tenantA}','${I.categoryA}','Pricing Product A','simple',1.500,1.000,10,'active'),
    ('${I.productB}','${I.tenantA}','${I.categoryA}','Pricing Product B','simple',2.000,1.250,10,'active')
  ON CONFLICT (id) DO NOTHING;
`);

const previewA = jsonAsUser(
  I.tenantManagerA,
  `SELECT public.preview_product_pricing_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,NULL::uuid,NULL::public.sales_channel)`
);
assertEqual("system default markup is 33%", String(previewA.markup_basis_points), "3300");
assertEqual("system default increment is 25 fils", String(previewA.rounding_increment_fils), "25");
assertEqual("default rounding mode is deterministic nearest-half-up", previewA.rounding_mode, "nearest_half_up");
assertEqual("1000 fils +33% raw numerator", String(previewA.raw_price_numerator), "13300000");
assertEqual("raw denominator", String(previewA.raw_price_denominator), "10000");
assertEqual("1000 fils rounds to approved retail increment", String(previewA.rounded_price_fils), "1325");
assertEqual("system fallback is explicit", previewA.rule_scope, "system_default");
assertEqual("preview is non-mutating", scalar(`SELECT price_fils::text FROM public.products WHERE id='${I.productA}'::uuid;`), "1500");

assertEqual(
  "half-up tie rounds upward",
  scalar("SELECT (public.calculate_bahrain_retail_price_v1(1250::bigint,3300,25::bigint,'nearest_half_up')->>'rounded_price_fils');"),
  "1675"
);
assertEqual(
  "ceil mode uses approved increment",
  scalar("SELECT (public.calculate_bahrain_retail_price_v1(1000::bigint,3300,25::bigint,'ceil')->>'rounded_price_fils');"),
  "1350"
);

const setRule = (actor, branchId, categoryId, productId, markup, mode, operationId, reason = "Pricing policy activation") => asUser(
  actor,
  `SELECT public.set_pricing_policy_rule_v1(
    '${I.tenantA}'::uuid,
    ${branchId ? `'${branchId}'::uuid` : "NULL::uuid"},
    ${categoryId ? `'${categoryId}'::uuid` : "NULL::uuid"},
    ${productId ? `'${productId}'::uuid` : "NULL::uuid"},
    ${markup}::integer,25::bigint,'${mode}',
    '${reason}','${operationId}'
  )::text`
);

expectReject("cashier cannot activate pricing policy", I.cashierA,
  `SELECT public.set_pricing_policy_rule_v1('${I.tenantA}'::uuid,'${I.branchA}'::uuid,NULL,NULL,3300,25,'nearest_half_up','Denied cashier policy','pricing-cashier-denied-131')`);
expectReject("branch manager cannot set tenant-wide policy", I.branchManagerA,
  `SELECT public.set_pricing_policy_rule_v1('${I.tenantA}'::uuid,NULL,NULL,NULL,3300,25,'nearest_half_up','Denied tenant policy','pricing-branch-global-denied-131')`);
expectReject("cross-tenant category rejected", I.tenantManagerA,
  `SELECT public.set_pricing_policy_rule_v1('${I.tenantA}'::uuid,NULL,'${I.categoryB}'::uuid,NULL,3300,25,'nearest_half_up','Wrong category','pricing-wrong-category-131')`);

const tenantRuleId = setRule(I.tenantManagerA, null, null, null, 3300, "nearest_half_up", "pricing-tenant-rule-131");
assertEqual("tenant policy replay returns same rule", setRule(I.tenantManagerA, null, null, null, 3300, "nearest_half_up", "pricing-tenant-rule-131"), tenantRuleId);
expectReject("policy operation ID cannot change payload", I.tenantManagerA,
  `SELECT public.set_pricing_policy_rule_v1('${I.tenantA}'::uuid,NULL,NULL,NULL,3400,25,'nearest_half_up','Pricing policy activation','pricing-tenant-rule-131')`);

const branchRuleId = setRule(I.branchManagerA, I.branchA, null, null, 4000, "ceil", "pricing-branch-rule-131");
const categoryRuleId = setRule(I.tenantManagerA, null, I.categoryA, null, 2500, "nearest_half_up", "pricing-category-rule-131");
const productRuleId = setRule(I.branchManagerA, I.branchA, null, I.productA, 5000, "nearest_half_up", "pricing-product-branch-rule-131");
assert(tenantRuleId && branchRuleId && categoryRuleId && productRuleId, "all expected pricing scopes must activate");

const categoryPreview = jsonAsUser(I.tenantManagerA,
  `SELECT public.preview_product_pricing_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,NULL::uuid,NULL::public.sales_channel)`);
assertEqual("category rule governs base repricing", categoryPreview.rule_scope, "category");
assertEqual("base repricing uses category markup", String(categoryPreview.rounded_price_fils), "1250");

const branchPreview = jsonAsUser(
  I.branchManagerA,
  `SELECT public.preview_product_pricing_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'${I.branchA}'::uuid,NULL::public.sales_channel)`
);
assertEqual("product+branch override wins", branchPreview.rule_scope, "product_branch");
assertEqual("product override markup", String(branchPreview.markup_basis_points), "5000");
assertEqual("product override rounded price", String(branchPreview.rounded_price_fils), "1500");
assertEqual("preview explains cost", String(branchPreview.cost_fils), "1000");
assertEqual("preview identifies selected rule", branchPreview.rule_id, productRuleId);

expectReject("branch manager cannot preview another branch", I.branchManagerA,
  `SELECT public.preview_product_pricing_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'${I.branchA2}'::uuid,NULL::public.sales_channel)`);
expectReject("cross-tenant manager cannot preview", I.managerB,
  `SELECT public.preview_product_pricing_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,NULL::uuid,NULL::public.sales_channel)`);

const applyBase = (expectedCost, operationId) => `SELECT public.apply_product_pricing_policy_v1(
  '${I.tenantA}'::uuid,'${I.productA}'::uuid,NULL::uuid,NULL::public.sales_channel,
  ${expectedCost}::bigint,'Explicit manager repricing','${operationId}'
)`;
expectReject("stale cost blocks apply", I.tenantManagerA, applyBase(999, "pricing-stale-apply-131"), /stale|cost/i);
const applied = jsonAsUser(I.tenantManagerA, applyBase(1000, "pricing-base-apply-131"));
assertEqual("explicit apply uses category rule", applied.rule_scope, "category");
assertEqual("explicit apply price", String(applied.applied_price_fils), "1250");
assertEqual("base price changed only after apply", scalar(`SELECT price_fils::text FROM public.products WHERE id='${I.productA}'::uuid;`), "1250");
const replay = jsonAsUser(I.tenantManagerA, applyBase(1000, "pricing-base-apply-131"));
assertEqual("apply replay is stable", JSON.stringify(replay), JSON.stringify(applied));
assertEqual("price history records explicit policy apply exactly once", scalar(`SELECT count(*)::text FROM public.product_prices WHERE product_id='${I.productA}'::uuid AND price_type='selling' AND operation_id LIKE 'pricing-policy:%pricing-base-apply-131';`), "1");
assertEqual("policy apply audit exactly once", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='catalogue.pricing_policy_applied' AND entity_id='${I.productA}'::uuid;`), "1");

const branchApply = jsonAsUser(
  I.branchManagerA,
  `SELECT public.apply_product_pricing_policy_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'${I.branchA}'::uuid,NULL::public.sales_channel,1000::bigint,'Branch policy repricing','pricing-branch-apply-131')`
);
assertEqual("branch apply uses product+branch override", branchApply.rule_scope, "product_branch");
assertEqual("branch policy writes local price", scalar(`SELECT local_price_fils::text FROM public.branch_products WHERE tenant_id='${I.tenantA}'::uuid AND branch_id='${I.branchA}'::uuid AND product_id='${I.productA}'::uuid;`), "1500");
expectReject("branch manager cannot apply another branch", I.branchManagerA,
  `SELECT public.apply_product_pricing_policy_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'${I.branchA2}'::uuid,NULL::public.sales_channel,1000,'Wrong branch','pricing-wrong-branch-apply-131')`);

assertEqual("direct pricing rule insert denied", asUser(I.tenantManagerA,
  `SELECT has_table_privilege('authenticated','public.pricing_policy_rules','INSERT')::text`), "false");
assertEqual("direct pricing rule update denied", asUser(I.tenantManagerA,
  `SELECT has_table_privilege('authenticated','public.pricing_policy_rules','UPDATE')::text`), "false");
assertEqual("direct pricing operation writes denied", asUser(I.tenantManagerA,
  `SELECT has_table_privilege('authenticated','public.pricing_policy_operations','INSERT')::text`), "false");
assertEqual("cross-tenant rules hidden", asUser(I.managerB,
  `SELECT count(*)::text FROM public.pricing_policy_rules WHERE tenant_id='${I.tenantA}'::uuid`), "0");

assertEqual("manual override remains available", asUser(I.tenantManagerA,
  `SELECT public.set_product_selling_price_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,NULL::uuid,NULL::public.sales_channel,1400::bigint,'Explicit manual override','pricing-manual-override-131')::text`), I.productA);
assertEqual("manual override wins until another explicit apply", scalar(`SELECT price_fils::text FROM public.products WHERE id='${I.productA}'::uuid;`), "1400");
assertEqual("policy did not auto-reapply after manual override", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='catalogue.pricing_policy_applied' AND entity_id='${I.productA}'::uuid;`), "2");

assertEqual("deactivate product override", asUser(I.branchManagerA,
  `SELECT public.deactivate_pricing_policy_rule_v1('${I.tenantA}'::uuid,'${productRuleId}'::uuid,'Return to inherited policy','pricing-deactivate-rule-131')::text`), productRuleId);
const inheritedPreview = jsonAsUser(
  I.branchManagerA,
  `SELECT public.preview_product_pricing_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'${I.branchA}'::uuid,NULL::public.sales_channel)`
);
assertEqual("deactivation restores category precedence", inheritedPreview.rule_scope, "category");
assertEqual("category override inherited", String(inheritedPreview.markup_basis_points), "2500");
assertEqual("rule history preserved", scalar(`SELECT count(*)::text FROM public.pricing_policy_rules WHERE tenant_id='${I.tenantA}'::uuid AND product_id='${I.productA}'::uuid AND branch_id='${I.branchA}'::uuid;`), "1");
assertEqual("deactivated rule is historical", scalar(`SELECT effective_to IS NOT NULL FROM public.pricing_policy_rules WHERE id='${productRuleId}'::uuid;`), "t");

process.stdout.write("Bahrain pricing policy PASS: exact 33% arithmetic, approved 25-fils rounding, scoped policy precedence, explicit manager activation/apply, stale-cost protection, idempotency, RLS, audit, price-history integration and manual overrides hold.\n");
