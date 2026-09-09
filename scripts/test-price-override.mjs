import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "14000000-0000-0000-0000-000000000091",
  tenantB: "14000000-0000-0000-0000-000000000092",
  branchA: "24000000-0000-0000-0000-000000000091",
  branchA2: "24000000-0000-0000-0000-000000000093",
  branchB: "24000000-0000-0000-0000-000000000092",
  cashierA: "34000000-0000-0000-0000-000000000091",
  managerA: "34000000-0000-0000-0000-000000000094",
  managerA2: "34000000-0000-0000-0000-000000000093",
  managerB: "34000000-0000-0000-0000-000000000092",
  registerA: "44000000-0000-0000-0000-000000000091",
  sessionA: "44000000-0000-0000-0000-000000000092",
  centerA: "44000000-0000-0000-0000-000000000093",
  productA: "54000000-0000-0000-0000-000000000091",
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
function expectReject(label, userId, statement, pattern = /forbidden|permission|authorized|stale|consumed|branch|business/i) {
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
    ('${I.cashierA}','override-cashier-a@zaipos.test','{}'),
    ('${I.managerA}','override-manager-a@zaipos.test','{}'),
    ('${I.managerA2}','override-manager-a2@zaipos.test','{}'),
    ('${I.managerB}','override-manager-b@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Override Tenant A','override-tenant-a','BHD',10,false),
    ('${I.tenantB}','Override Tenant B','override-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Override Branch A','active'),
    ('${I.branchA2}','${I.tenantA}','Override Branch A2','active'),
    ('${I.branchB}','${I.tenantB}','Override Branch B','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.managerA}','${I.tenantA}','${I.branchA}','manager'),
    ('${I.managerA2}','${I.tenantA}','${I.branchA2}','manager'),
    ('${I.managerB}','${I.tenantB}','${I.branchB}','manager')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.cash_registers(id,tenant_id,branch_id,name,status) VALUES
    ('${I.registerA}','${I.tenantA}','${I.branchA}','Override Register','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.cash_sessions(id,tenant_id,branch_id,register_id,user_id,status) VALUES
    ('${I.sessionA}','${I.tenantA}','${I.branchA}','${I.registerA}','${I.cashierA}','open')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES
    ('${I.centerA}','${I.tenantA}','${I.branchA}','Override Centre','point_of_sale','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status) VALUES
    ('${I.productA}','${I.tenantA}','Override Water','simple',1.250,0.750,0,'active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.productA}',10.000)
  ON CONFLICT (inventory_center_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity;
`);

assertEqual(
  "cashier request permission",
  asUser(I.cashierA, `SELECT public.current_user_has_branch_permission('${I.tenantA}'::uuid,'${I.branchA}'::uuid,'pos.price_override.request')::text;`),
  "true",
);
assertEqual(
  "cashier approval permission",
  asUser(I.cashierA, `SELECT public.current_user_has_branch_permission('${I.tenantA}'::uuid,'${I.branchA}'::uuid,'pos.price_override.approve')::text;`),
  "false",
);
assertEqual(
  "manager approval permission",
  asUser(I.managerA, `SELECT public.current_user_has_branch_permission('${I.tenantA}'::uuid,'${I.branchA}'::uuid,'pos.price_override.approve')::text;`),
  "true",
);

const requestSql = (operationId, priceFils = 1000) => `SELECT public.request_price_override_v1('${I.tenantA}'::uuid,'${I.branchA}'::uuid,'${I.productA}'::uuid,'pos'::public.sales_channel,1.000,${priceFils}::bigint,'Customer price match','${operationId}')::text;`;
const requestId = asUser(I.cashierA, requestSql("override-request-operation-91"));
assertEqual("request replay", asUser(I.cashierA, requestSql("override-request-operation-91")), requestId);
assertEqual("request pending", scalar(`SELECT status FROM public.price_override_requests WHERE id='${requestId}'::uuid;`), "pending");
assertEqual("request original price", scalar(`SELECT original_unit_price_fils::text FROM public.price_override_requests WHERE id='${requestId}'::uuid;`), "1250");
assertEqual("requester can fetch status", JSON.parse(asUser(I.cashierA, `SELECT public.get_price_override_request_v1('${requestId}'::uuid)::text;`)).status, "pending");
expectReject("wrong branch cannot fetch request", I.managerA2, `SELECT public.get_price_override_request_v1('${requestId}'::uuid);`);
assertEqual("manager branch pending list", String(JSON.parse(asUser(I.managerA, `SELECT public.list_pending_price_overrides_v1('${I.branchA}'::uuid)::text;`)).length), "1");
expectReject("cashier cannot list branch approvals", I.cashierA, `SELECT public.list_pending_price_overrides_v1('${I.branchA}'::uuid);`);
expectReject("cross tenant manager cannot list approvals", I.managerB, `SELECT public.list_pending_price_overrides_v1('${I.branchA}'::uuid);`);
assertEqual("one request audit", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='pos.price_override_requested' AND entity_id='${requestId}'::uuid;`), "1");

const decideSql = (operationId, approve = true) => `SELECT public.decide_price_override_v1('${requestId}'::uuid,${approve},'Approved at till','${operationId}')::text;`;
expectReject("cashier cannot approve", I.cashierA, decideSql("override-cashier-decision-91"));
expectReject("wrong branch manager cannot approve", I.managerA2, decideSql("override-wrong-branch-decision-91"));
expectReject("cross tenant manager cannot approve", I.managerB, decideSql("override-cross-tenant-decision-91"));
assertEqual("manager approval", asUser(I.managerA, decideSql("override-manager-decision-91")), requestId);
assertEqual("manager approval replay", asUser(I.managerA, decideSql("override-manager-decision-91")), requestId);
assertEqual("request approved", scalar(`SELECT status FROM public.price_override_requests WHERE id='${requestId}'::uuid;`), "approved");
assertEqual("approving manager", scalar(`SELECT approved_by::text FROM public.price_override_requests WHERE id='${requestId}'::uuid;`), I.managerA);
assertEqual("one approval audit", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='pos.price_override_approved' AND entity_id='${requestId}'::uuid;`), "1");

const selfRequestId = asUser(I.managerA, requestSql("override-manager-self-request-91", 1150));
expectReject("manager cannot self approve", I.managerA, `SELECT public.decide_price_override_v1('${selfRequestId}'::uuid,true,'Self approval','override-manager-self-decision-91');`);
const rejectedId = asUser(I.cashierA, requestSql("override-request-operation-93", 1050));
assertEqual("manager rejection", asUser(I.managerA, `SELECT public.decide_price_override_v1('${rejectedId}'::uuid,false,'No matching policy','override-manager-decision-93')::text;`), rejectedId);
assertEqual("manager rejection replay", asUser(I.managerA, `SELECT public.decide_price_override_v1('${rejectedId}'::uuid,false,'No matching policy','override-manager-decision-93')::text;`), rejectedId);
assertEqual("request rejected", scalar(`SELECT status FROM public.price_override_requests WHERE id='${rejectedId}'::uuid;`), "rejected");
assertEqual("one rejection audit", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='pos.price_override_rejected' AND entity_id='${rejectedId}'::uuid;`), "1");

const items = JSON.stringify([{ product_id: I.productA, quantity: "1.000", discount_fils: 0, price_override_request_id: requestId }]).replaceAll("'", "''");
const payments = JSON.stringify([{ method: "cash", amount_fils: 1000, reference: null }]).replaceAll("'", "''");
const checkout = (operationId) => `SELECT public.checkout_sale_v2('${I.tenantA}'::uuid,'${I.branchA}'::uuid,'${items}'::jsonb,'${payments}'::jsonb,0::bigint,NULL,NULL::uuid,'pos'::public.sales_channel,0::bigint,NULL,'${operationId}','${I.sessionA}'::uuid)::text;`;
const saleId = asUser(I.cashierA, checkout("override-checkout-operation-91"));
assertEqual("checkout replay", asUser(I.cashierA, checkout("override-checkout-operation-91")), saleId);
assertEqual("override sale total", scalar(`SELECT total_fils::text FROM public.sales WHERE id='${saleId}'::uuid;`), "1000");
assertEqual("override item price", scalar(`SELECT unit_price_fils::text FROM public.sale_items WHERE sale_id='${saleId}'::uuid;`), "1000");
assertEqual("historical original price", scalar(`SELECT original_unit_price_fils::text FROM public.sale_items WHERE sale_id='${saleId}'::uuid;`), "1250");
assertEqual("historical approval link", scalar(`SELECT price_override_request_id::text FROM public.sale_items WHERE sale_id='${saleId}'::uuid;`), requestId);
assertEqual("approval consumed", scalar(`SELECT status FROM public.price_override_requests WHERE id='${requestId}'::uuid;`), "consumed");
assertEqual("approval consumed sale", scalar(`SELECT consumed_sale_id::text FROM public.price_override_requests WHERE id='${requestId}'::uuid;`), saleId);
assertEqual("one consume audit", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='pos.price_override_consumed' AND entity_id='${requestId}'::uuid;`), "1");
assertEqual("approval decision replay after consumption", asUser(I.managerA, decideSql("override-manager-decision-91")), requestId);
expectReject("approval cannot fund another sale", I.cashierA, checkout("override-checkout-operation-92"));

const staleId = asUser(I.cashierA, requestSql("override-request-operation-92", 1100));
asUser(I.managerA, `SELECT public.decide_price_override_v1('${staleId}'::uuid,true,'Approved before price change','override-manager-decision-92')::text;`);
sql(`UPDATE public.products SET price_fils=1500, price=1.500 WHERE id='${I.productA}'::uuid;`);
const staleItems = JSON.stringify([{ product_id: I.productA, quantity: "1.000", discount_fils: 0, price_override_request_id: staleId }]).replaceAll("'", "''");
expectReject(
  "changed authoritative price invalidates approval",
  I.cashierA,
  `SELECT public.checkout_sale_v2('${I.tenantA}'::uuid,'${I.branchA}'::uuid,'${staleItems}'::jsonb,'${payments}'::jsonb,0::bigint,NULL,NULL::uuid,'pos'::public.sales_channel,0::bigint,NULL,'override-stale-checkout-91','${I.sessionA}'::uuid);`,
);

for (const table of ["price_override_requests", "role_permissions"]) {
  for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
    assertEqual(`${table} authenticated ${privilege}`, scalar(`SELECT has_table_privilege('authenticated','public.${table}','${privilege}');`), "f");
  }
}
assertEqual("arbitrary-user permission probe revoked", scalar("SELECT has_function_privilege('authenticated','public.has_branch_permission(uuid,uuid,uuid,text)','EXECUTE');"), "f");

process.stdout.write("Price override PASS: explicit permissions, branch approval, exact fils, one-time checkout consumption, audit and mutation lockdown hold.\n");
