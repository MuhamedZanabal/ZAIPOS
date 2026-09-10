import { execFileSync, spawn } from "node:child_process";

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
const historicalSales = scalar("SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY id)::text,'')) FROM public.sales s;");
const historicalLines = scalar("SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY id)::text,'')) FROM public.sale_items s;");
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
expectReject("unbounded operation ID rejected", I.tenantManagerA,
  `SELECT public.set_pricing_policy_rule_v1('${I.tenantA}'::uuid,NULL,NULL,NULL,3300,25,'nearest_half_up','Invalid oversized operation','${'x'.repeat(201)}')`, /operation/i);

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
assertEqual("preview records responsible actor", branchPreview.previewed_by, I.branchManagerA);
assert(!Number.isNaN(Date.parse(branchPreview.generated_at)), "preview must carry authoritative generation time");

expectReject("branch manager cannot preview another branch", I.branchManagerA,
  `SELECT public.preview_product_pricing_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,'${I.branchA2}'::uuid,NULL::public.sales_channel)`);
expectReject("cross-tenant manager cannot preview", I.managerB,
  `SELECT public.preview_product_pricing_v1('${I.tenantA}'::uuid,'${I.productA}'::uuid,NULL::uuid,NULL::public.sales_channel)`);

const applyBase = (expectedCost, operationId) => `SELECT public.apply_product_pricing_policy_v1(
  '${I.tenantA}'::uuid,'${I.productA}'::uuid,NULL::uuid,NULL::public.sales_channel,
  ${expectedCost}::bigint,'Explicit manager repricing','${operationId}'
)`;
expectReject("cost-only apply cannot bypass preview approval", I.tenantManagerA, applyBase(1000, "pricing-unsafe-apply-131"), /permission/i);
const quote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const preview = (product = I.productA, branch = null) => jsonAsUser(I.tenantManagerA,
  `SELECT public.preview_product_pricing_v1('${I.tenantA}','${product}',${branch ? `'${branch}'` : 'NULL'},NULL)`);
const batch = (previews, operationId, branch = null) => `SELECT public.apply_pricing_batch_v1(
  '${I.tenantA}',${branch ? `'${branch}'` : 'NULL'},NULL,${quote(previews)},'Explicit manager repricing','${operationId}')`;
const basePreview = preview();
expectReject("stale cost blocks apply", I.tenantManagerA,
  batch([{...basePreview, cost_fils: '999'}], "pricing-stale-apply-131"), /stale/i);
const applied = jsonAsUser(I.tenantManagerA, batch([basePreview], "pricing-base-apply-131"))[0];
assertEqual("explicit apply uses category rule", applied.rule_scope, "category");
assertEqual("explicit apply price", String(applied.applied_price_fils), "1250");
assertEqual("base price changed only after apply", scalar(`SELECT price_fils::text FROM public.products WHERE id='${I.productA}'::uuid;`), "1250");
const replay = jsonAsUser(I.tenantManagerA, batch([basePreview], "pricing-base-apply-131"))[0];
assertEqual("apply replay is stable", JSON.stringify(replay), JSON.stringify(applied));
assertEqual("price history records explicit policy apply exactly once", scalar(`SELECT count(*)::text FROM public.product_prices WHERE product_id='${I.productA}'::uuid AND price_type='selling' AND operation_id='${applied.financial_operation_id}';`), "1");
assertEqual("policy apply audit exactly once", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='catalogue.pricing_policy_applied' AND entity_id='${I.productA}'::uuid;`), "1");

const branchApply = jsonAsUser(
  I.branchManagerA,
  batch([preview(I.productA, I.branchA)], 'pricing-branch-apply-131', I.branchA)
);
assertEqual("branch apply uses product+branch override", branchApply[0].rule_scope, "product_branch");
assertEqual("branch policy writes local price", scalar(`SELECT local_price_fils::text FROM public.branch_products WHERE tenant_id='${I.tenantA}'::uuid AND branch_id='${I.branchA}'::uuid AND product_id='${I.productA}'::uuid;`), "1500");
expectReject("branch manager cannot apply another branch", I.branchManagerA,
  batch([preview(I.productA, I.branchA2)], 'pricing-wrong-branch-apply-131', I.branchA2));

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
assertEqual('deactivation audit captures resulting state', scalar(`SELECT (metadata->>'resulting_effective_to' IS NOT NULL)::text FROM public.audit_logs WHERE action='catalogue.pricing_policy_rule_deactivated' AND entity_id='${productRuleId}'`), 'true');

// Exhaustive small-price boundaries and values beyond JavaScript's exact range.
for (const mode of ['nearest_half_up', 'ceil']) {
  const costs = [...Array(1001).keys()].map(BigInt).concat([9007199254740993n, 1000000000000000000n]);
  const values = costs.map(cost => {
    const numerator = cost * 13300n;
    const expected = ((numerator + (mode === 'ceil' ? 249999n : 125000n)) / 250000n) * 25n;
    return `(${cost},'${expected}')`;
  }).join(',');
  assertEqual(`exact ${mode} boundaries`, scalar(`SELECT count(*) FROM (VALUES ${values}) v(cost,expected)
    WHERE public.calculate_bahrain_retail_price_v1(cost::bigint,3300,25,'${mode}')->>'rounded_price_fils' <> expected;`), '0');
}
for (const args of ["NULL,3300,25,'ceil'", "-1,3300,25,'ceil'", "1,NULL,25,'ceil'",
  "1,3300,NULL,'ceil'", "1,3300,25,NULL", "1,3300,25,'invalid'", "9223372036854775807,3300,25,'ceil'"]) {
  expectReject(`invalid calculation ${args}`, I.tenantManagerA,
    `SELECT public.calculate_bahrain_retail_price_v1(${args})`, /nonnegative|invalid|increment|rounding|range/i);
}

const beforePolicyChange = preview();
setRule(I.tenantManagerA, null, I.categoryA, null, 3300, 'nearest_half_up', 'pricing-category-change-131');
assertEqual('rule replacement audit captures before state', scalar(`SELECT (metadata->'previous_rule'->>'id' IS NOT NULL)::text FROM public.audit_logs WHERE action='catalogue.pricing_policy_rule_set' AND metadata->>'operation_id'='pricing-category-change-131'`), 'true');
expectReject('policy changed after approval', I.tenantManagerA,
  batch([beforePolicyChange], 'pricing-stale-policy-131'), /stale/i);
const beforeManualChange = preview();
asUser(I.tenantManagerA, `SELECT public.set_product_selling_price_v1('${I.tenantA}','${I.productA}',NULL,NULL,1700,'New manual price','pricing-manual-again-131')`);
expectReject('manual price changed after approval', I.tenantManagerA,
  batch([beforeManualChange], 'pricing-stale-manual-131'), /stale/i);
const beforeCostChange = preview(I.productB);
sql(`UPDATE public.products SET cost=1.500,cost_fils=1500 WHERE id='${I.productB}';`);
expectReject('cost history changed after approval', I.tenantManagerA,
  batch([beforeCostChange], 'pricing-stale-cost-history-131'), /stale/i);
assertEqual('cost change alone preserves selling price', scalar(`SELECT price_fils FROM public.products WHERE id='${I.productB}'`), '2000');
const validA = preview();
const validB = preview(I.productB);
expectReject('one stale line rolls back entire batch', I.tenantManagerA,
  batch([validA, {...validB, cost_fils: '999'}], 'pricing-atomic-reject-131'), /stale/i);
assertEqual('failed batch preserves first price', scalar(`SELECT price_fils FROM public.products WHERE id='${I.productA}'`), '1700');
assertEqual('failed batch leaves no operation', scalar(`SELECT count(*) FROM public.pricing_policy_operations WHERE tenant_id='${I.tenantA}' AND operation_id='pricing-atomic-reject-131'`), '0');
for (const actor of [I.cashierA, I.managerB, I.branchManagerA]) {
  expectReject('batch enforces tenant-global authorization', actor, batch([validA], 'pricing-batch-denied-131'));
}
expectReject('duplicate selection rejected', I.tenantManagerA, batch([validA, validA], 'pricing-duplicate-131'), /exactly once/i);
expectReject('empty selection rejected', I.tenantManagerA, batch([], 'pricing-empty-131'), /between 1 and 100/i);
expectReject('unbounded selection rejected', I.tenantManagerA, batch(Array(101).fill(validA), 'pricing-too-large-131'), /between 1 and 100/i);

// Separate PostgreSQL sessions race; both must use the exact same reviewed state.
function concurrent(statement) {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [dbUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c',
      `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${I.tenantManagerA}'; SELECT pg_advisory_xact_lock_shared(7313131); ${statement}; COMMIT;`]);
    let out = '', err = '';
    child.stdout.on('data', s => { out += s; });
    child.stderr.on('data', s => { err += s; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
  });
}
async function overlap(statements) {
  const gate = spawn('psql', [dbUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {stdio:['pipe','pipe','pipe']});
  const closed = new Promise(resolve => gate.on('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Concurrency gate did not open')), 10000);
      gate.on('error', error => {clearTimeout(timer); reject(error);});
      gate.stdout.on('data', data => { if (String(data).includes('gate-ready')) {clearTimeout(timer); resolve();} });
      gate.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(7313131); SELECT 'gate-ready';\n");
    });
    const results = Promise.allSettled(statements.map(concurrent));
    const deadline = Date.now() + 10000;
    while (Number(scalar("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=7313131 AND mode='ShareLock' AND NOT granted;")) < statements.length) {
      if (Date.now() >= deadline) throw new Error('Both PostgreSQL sessions must overlap at the concurrency barrier');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    gate.stdin.end('COMMIT;\n\\q\n');
    await closed;
    return await results;
  } finally { if (gate.exitCode === null) gate.kill(); }
}
const same = await overlap([
  batch([validA, validB], 'pricing-concurrent-same-131'),
  batch([validA, validB], 'pricing-concurrent-same-131'),
]);
assert(same.every(r => r.status === 'fulfilled'), `Both same-operation calls must commit: ${JSON.stringify(same)}`);
assertEqual('same operation converges', same[0].value, same[1].value);
assertEqual('same operation has one batch audit', scalar(`SELECT count(*) FROM public.audit_logs WHERE tenant_id='${I.tenantA}' AND action='catalogue.pricing_batch_applied' AND metadata->>'operation_id'='pricing-concurrent-same-131'`), '1');
asUser(I.tenantManagerA, `SELECT public.set_product_selling_price_v1('${I.tenantA}','${I.productA}',NULL,NULL,1900,'Manual price before contention','pricing-before-race-131')`);
const racePreview = preview();
const race = await overlap([
  batch([racePreview], 'pricing-concurrent-distinct-a-131'),
  batch([racePreview], 'pricing-concurrent-distinct-b-131'),
]);
assertEqual('distinct operations have one winner', race.filter(r => r.status === 'fulfilled').length, 1);
const failed = race.find(r => r.status === 'rejected');
assert(failed && /stale/i.test(failed.reason.message), 'second pricing writer must reject stale approval');
sql(`UPDATE public.products SET cost=0,cost_fils=0 WHERE id='${I.productB}';`);
expectReject('zero product cost cannot produce a selling-price recommendation', I.tenantManagerA,
  `SELECT public.preview_product_pricing_v1('${I.tenantA}','${I.productB}',NULL,NULL)`, /positive.*cost/i);
assertEqual('completed sales unchanged', scalar("SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY id)::text,'')) FROM public.sales s;"), historicalSales);
assertEqual('historical selling price, VAT and COGS unchanged', scalar("SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY id)::text,'')) FROM public.sale_items s;"), historicalLines);

process.stdout.write('Bahrain pricing policy PASS: exact boundaries, scoped rules, approval snapshots, atomic batches, real concurrent replay/contention, authorization, RLS, audit and canonical history.\n');
