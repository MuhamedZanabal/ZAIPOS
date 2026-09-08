import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "13000000-0000-0000-0000-000000000081",
  tenantB: "13000000-0000-0000-0000-000000000082",
  branchA: "23000000-0000-0000-0000-000000000081",
  branchB: "23000000-0000-0000-0000-000000000082",
  cashierA: "33000000-0000-0000-0000-000000000081",
  managerB: "33000000-0000-0000-0000-000000000082",
  centerA: "43000000-0000-0000-0000-000000000081",
  productA: "53000000-0000-0000-0000-000000000081",
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
function expectReject(label, userId, statement, pattern = /not authorized|forbidden|permission denied|resolution|conflict|held/i) {
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
    ('${I.cashierA}','held-cashier-a@zaipos.test','{"full_name":"Cashier A"}'),
    ('${I.managerB}','held-manager-b@zaipos.test','{"full_name":"Manager B"}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Held Tenant A','held-tenant-a','BHD',10,false),
    ('${I.tenantB}','Held Tenant B','held-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Held Branch A','active'),
    ('${I.branchB}','${I.tenantB}','Held Branch B','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier'),
    ('${I.managerB}','${I.tenantB}','${I.branchB}','manager')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status) VALUES
    ('${I.centerA}','${I.tenantA}','${I.branchA}','Held Centre','point_of_sale','active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status) VALUES
    ('${I.productA}','${I.tenantA}','Held Water','simple',1.250,0.750,10,'active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity) VALUES
    ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.productA}',2.000)
  ON CONFLICT (inventory_center_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity;
`);

const items = JSON.stringify([{
  line_id: "water",
  product_id: I.productA,
  quantity: 2,
  expected_unit_price_fils: 1250,
  discount_fils: 0,
  modifiers: [],
}]).replaceAll("'", "''");
const hold = (operation, label = "Lunch order") => `SELECT public.hold_cart_v1('${I.branchA}'::uuid,'${label}','pos',NULL,NULL,'${items}'::jsonb,'${operation}')::text;`;
const cartId = asUser(I.cashierA, hold("hold-cart-operation-81"));
assertEqual("hold replay", asUser(I.cashierA, hold("hold-cart-operation-81")), cartId);
assertEqual("one held audit", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='pos.cart_held' AND entity_id='${cartId}'::uuid;`), "1");

const listed = JSON.parse(asUser(I.cashierA, `SELECT public.list_held_carts_v1('${I.branchA}'::uuid)::text;`));
assertEqual("branch list count", String(listed.length), "1");
assertEqual("held item count", String(listed[0].item_count), "1");
expectReject("cross-tenant preview", I.managerB, `SELECT public.preview_held_cart_resume_v1('${cartId}'::uuid);`);

sql(`
  UPDATE public.products SET price=1.500 WHERE id='${I.productA}'::uuid;
  UPDATE public.inventory_stocks SET quantity=1.000 WHERE inventory_center_id='${I.centerA}'::uuid AND product_id='${I.productA}'::uuid;
`);

const preview = JSON.parse(asUser(I.cashierA, `SELECT public.preview_held_cart_resume_v1('${cartId}'::uuid)::text;`));
assertEqual("expected held price", String(preview.items[0].expected_unit_price_fils), "1250");
assertEqual("current price", String(preview.items[0].current_unit_price_fils), "1500");
assertEqual("price conflict", String(preview.items[0].issues.includes("price_changed")), "true");
assertEqual("stock conflict", String(preview.items[0].issues.includes("insufficient_stock")), "true");
assertEqual("available quantity", String(preview.items[0].available_quantity), "1");

expectReject(
  "unresolved resume",
  I.cashierA,
  `SELECT public.resume_held_cart_v1('${cartId}'::uuid,'[]'::jsonb,'resume-cart-operation-81');`,
);
const resolutions = JSON.stringify([{ line_id: "water", accept_current_price: true, quantity: 1, remove: false }]).replaceAll("'", "''");
const resumed = JSON.parse(asUser(I.cashierA, `SELECT public.resume_held_cart_v1('${cartId}'::uuid,'${resolutions}'::jsonb,'resume-cart-operation-81')::text;`));
assertEqual("resumed quantity", String(resumed.items[0].quantity), "1");
assertEqual("resumed current price", String(resumed.items[0].current_unit_price_fils), "1500");
assertEqual("resume replay", asUser(I.cashierA, `SELECT public.resume_held_cart_v1('${cartId}'::uuid,'${resolutions}'::jsonb,'resume-cart-operation-81')::text;`), JSON.stringify(resumed));
assertEqual("one resume audit", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='pos.cart_resumed' AND entity_id='${cartId}'::uuid;`), "1");

const discardCartId = asUser(I.cashierA, hold("hold-cart-operation-82", "Discard me"));
assertEqual("discard result", asUser(I.cashierA, `SELECT public.discard_held_cart_v1('${discardCartId}'::uuid,'Not needed','discard-cart-operation-82')::text;`), discardCartId);
assertEqual("discard status", scalar(`SELECT status FROM public.held_carts WHERE id='${discardCartId}'::uuid;`), "discarded");
assertEqual("one discard audit", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='pos.cart_discarded' AND entity_id='${discardCartId}'::uuid;`), "1");

for (const table of ["held_carts", "held_cart_items"]) {
  for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
    assertEqual(`${table} authenticated ${privilege}`, scalar(`SELECT has_table_privilege('authenticated','public.${table}','${privilege}');`), "f");
  }
}

process.stdout.write("Held carts PASS: branch scope, exact snapshots, explicit conflict resolution, idempotency, audit and mutation lockdown hold.\n");
