import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

const I = {
  tenantA: "12000000-0000-0000-0000-000000000073",
  tenantB: "12000000-0000-0000-0000-000000000074",
  branchA: "22000000-0000-0000-0000-000000000073",
  branchB: "22000000-0000-0000-0000-000000000074",
  cashierA: "32000000-0000-0000-0000-000000000073",
  managerB: "32000000-0000-0000-0000-000000000074",
  productA: "52000000-0000-0000-0000-000000000073",
  saleA: "62000000-0000-0000-0000-000000000073",
  itemA: "72000000-0000-0000-0000-000000000073",
  paymentA: "82000000-0000-0000-0000-000000000073",
};

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function sql(statement) { return psql(["-c", statement], false); }
function scalar(statement) { return psql(["-Atq", "-c", statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ""; }
function asAuthenticated(userId, statement) {
  return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectReject(label, userId, statement, pattern = /not authorized|permission denied|does not exist|conflicts/i) {
  try {
    asAuthenticated(userId, statement);
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.cashierA}','receipt-cashier-a@zaipos.test','{"full_name":"Original Cashier"}'),
    ('${I.managerB}','receipt-manager-b@zaipos.test','{"full_name":"Foreign Manager"}')
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.profiles SET full_name='Original Cashier' WHERE id='${I.cashierA}'::uuid;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,receipt_config) VALUES
    ('${I.tenantA}','Original Business','receipt-tenant-a','BHD',10,false,'{"footer_text":"Original footer"}'::jsonb),
    ('${I.tenantB}','Foreign Business','receipt-tenant-b','BHD',10,false,'{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,address,phone,status) VALUES
    ('${I.branchA}','${I.tenantA}','Original Branch','Original Road','+973 1700 0000','active'),
    ('${I.branchB}','${I.tenantB}','Foreign Branch',NULL,NULL,'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.managerB}','${I.tenantB}','${I.branchB}','manager')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status)
  VALUES ('${I.productA}','${I.tenantA}','Current Catalogue Name','simple',1.250,0.750,10,'active')
  ON CONFLICT (id) DO NOTHING;

  BEGIN;
  INSERT INTO public.sales(
    id,tenant_id,branch_id,user_id,ticket_number,subtotal,tax_total,discount_total,tip_amount,total,status,channel,client_mutation_id,created_at
  ) VALUES (
    '${I.saleA}','${I.tenantA}','${I.branchA}','${I.cashierA}',73,2.500,0.225,0.250,0.025,2.500,'completed','pos','receipt-fixture-sale','2026-09-05T09:00:00Z'
  ) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.sale_items(
    id,tenant_id,sale_id,product_id,product_name,product_type,quantity,unit_price,tax_rate,discount,line_total
  ) VALUES (
    '${I.itemA}','${I.tenantA}','${I.saleA}','${I.productA}','Historical Product Name','simple',2.000,1.250,10,0.250,2.475
  ) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.payments(id,tenant_id,sale_id,method,amount,reference)
  VALUES ('${I.paymentA}','${I.tenantA}','${I.saleA}','cash',2.500,NULL)
  ON CONFLICT (id) DO NOTHING;
  COMMIT;
`);

const prepare = (operationId) => `SELECT public.prepare_sale_receipt_reprint_v1('${I.saleA}'::uuid,'${operationId}')::text;`;
const first = JSON.parse(asAuthenticated(I.cashierA, prepare("receipt-reprint-operation-73")));

assertEqual("historical business", first.snapshot.business.name, "Original Business");
assertEqual("historical branch", first.snapshot.branch.name, "Original Branch");
assertEqual("historical cashier", first.snapshot.cashier.name, "Original Cashier");
assertEqual("historical product", first.snapshot.items[0].name, "Historical Product Name");
assertEqual("historical unit price fils", String(first.snapshot.items[0].unit_price_fils), "1250");
assertEqual("historical payment fils", String(first.snapshot.payments[0].amount_fils), "2500");
assertEqual("historical total fils", String(first.snapshot.totals.total_fils), "2500");

sql(`
  UPDATE public.tenants SET name='Changed Business' WHERE id='${I.tenantA}'::uuid;
  UPDATE public.branches SET name='Changed Branch' WHERE id='${I.branchA}'::uuid;
  UPDATE public.profiles SET full_name='Changed Cashier' WHERE id='${I.cashierA}'::uuid;
  UPDATE public.sale_items SET product_name='Changed Item' WHERE id='${I.itemA}'::uuid;
`);

const replay = JSON.parse(asAuthenticated(I.cashierA, prepare("receipt-reprint-operation-73")));
assertEqual("idempotent event", replay.event_id, first.event_id);
assertEqual("immutable branch", replay.snapshot.branch.name, "Original Branch");
assertEqual("immutable cashier", replay.snapshot.cashier.name, "Original Cashier");
assertEqual("immutable item", replay.snapshot.items[0].name, "Historical Product Name");
assertEqual("one requested audit", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='sale.receipt_reprint_requested' AND entity_id='${I.saleA}'::uuid;`), "1");

expectReject("cross-tenant reprint", I.managerB, prepare("receipt-cross-tenant"));
expectReject("operation payload conflict", I.cashierA, `SELECT public.prepare_sale_receipt_reprint_v1(gen_random_uuid(),'receipt-reprint-operation-73');`);

const completed = asAuthenticated(I.cashierA, `SELECT public.complete_sale_receipt_reprint_v1('${first.event_id}'::uuid,'printed',NULL)::text;`);
assertEqual("completed event", completed, first.event_id);
assertEqual("idempotent completion", asAuthenticated(I.cashierA, `SELECT public.complete_sale_receipt_reprint_v1('${first.event_id}'::uuid,'printed',NULL)::text;`), first.event_id);
assertEqual("one completion audit", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='sale.receipt_reprint_printed' AND metadata->>'reprint_event_id'='${first.event_id}';`), "1");
expectReject("conflicting completion", I.cashierA, `SELECT public.complete_sale_receipt_reprint_v1('${first.event_id}'::uuid,'failed','printer_failed')::text;`);

for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
  assertEqual(`receipt_reprint_events authenticated ${privilege}`, scalar(`SELECT has_table_privilege('authenticated','public.receipt_reprint_events','${privilege}');`), "f");
}

process.stdout.write("Receipt reprint PASS: immutable exact-fils snapshot, authorization, idempotency, direct-mutation lockdown and audit outcomes hold.\n");
