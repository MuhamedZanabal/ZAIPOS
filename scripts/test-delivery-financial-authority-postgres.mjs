import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenantA: "1d000000-0000-0000-0000-000000000001",
  tenantB: "1d000000-0000-0000-0000-000000000002",
  branchA: "2d000000-0000-0000-0000-000000000001",
  branchB: "2d000000-0000-0000-0000-000000000002",
  cashierA: "3d000000-0000-0000-0000-000000000001",
  centerA: "4d000000-0000-0000-0000-000000000001",
  productA: "5d000000-0000-0000-0000-000000000001",
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
function expectReject(label, userId, statement, pattern) {
  try { asUser(userId, statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

const v2Signature = "public.register_delivery_order_v2(uuid,uuid,jsonb,text,bigint,text,text,text,text,uuid,text)";
assertEqual(
  "delivery_orders has authoritative integer-fils delivery fee",
  scalar(`SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='delivery_orders' AND column_name='delivery_fee_fils';`),
  "bigint:NO",
);
assertEqual("authoritative delivery registration v2 exists", scalar(`SELECT to_regprocedure('${v2Signature}') IS NOT NULL;`), "t");
assertEqual("authenticated can execute v2", scalar(`SELECT has_function_privilege('authenticated','${v2Signature}','EXECUTE');`), "t");
assertEqual(
  "legacy delivery registration is not executable by authenticated clients",
  scalar(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='register_delivery_order'
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) THEN 'f' ELSE 't' END;`),
  "t",
);

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES ('${I.cashierA}','delivery-authority@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock) VALUES
    ('${I.tenantA}','Delivery Authority A','delivery-authority-a','BHD',10,false,false),
    ('${I.tenantB}','Delivery Authority B','delivery-authority-b','BHD',10,false,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Delivery Branch A','active'),
    ('${I.branchB}','${I.tenantB}','Delivery Branch B','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role)
  VALUES ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status)
  VALUES ('${I.centerA}','${I.tenantA}','${I.branchA}','Delivery POS','point_of_sale','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status)
  VALUES ('${I.productA}','${I.tenantA}','Authoritative Delivery Item','simple',1.000,0.500,0,'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity)
  VALUES ('${I.tenantA}','${I.branchA}','${I.centerA}','${I.productA}',3.000)
  ON CONFLICT (inventory_center_id, product_id) DO UPDATE SET quantity=EXCLUDED.quantity;
`);

const items = JSON.stringify([{
  product_id: I.productA,
  quantity: "1.000",
  discount_fils: 0,
  // Deliberately false client hints: checkout_sale_v2 must resolve price/tax server-side.
  unit_price_fils: 1,
  tax_rate: 99,
}]).replaceAll("'", "''");
const operationId = "delivery-authority-op-0001";
function deliveryCall({ address = "Amwaj Islands, Bahrain", feeFils = 250, op = operationId, tenant = I.tenantA, branch = I.branchA } = {}) {
  return `SELECT public.register_delivery_order_v2(
    '${tenant}'::uuid,
    '${branch}'::uuid,
    '${items}'::jsonb,
    '${address.replaceAll("'", "''")}',
    ${feeFils}::bigint,
    '${op}',
    'Delivery Customer',
    '+97330000000',
    'Amwaj Islands',
    NULL::uuid,
    'authority regression'
  )::text`;
}

const orderId = asUser(I.cashierA, deliveryCall());
if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new Error(`delivery creation did not return an order UUID: ${orderId}`);

assertEqual("delivery fee persisted exactly in fils", scalar(`SELECT delivery_fee_fils::text FROM public.delivery_orders WHERE id='${orderId}'::uuid;`), "250");
assertEqual("delivery legacy numeric compatibility mirrors exact fils", scalar(`SELECT (delivery_fee = 0.250::numeric)::text FROM public.delivery_orders WHERE id='${orderId}'::uuid;`), "t");
const saleId = scalar(`SELECT sale_id::text FROM public.delivery_orders WHERE id='${orderId}'::uuid;`);
if (!/^[0-9a-f-]{36}$/i.test(saleId)) throw new Error(`delivery did not link an authoritative sale: ${saleId}`);
assertEqual("server price authority ignored client unit-price hint", scalar(`SELECT unit_price_fils::text FROM public.sale_items WHERE sale_id='${saleId}'::uuid AND product_id='${I.productA}'::uuid;`), "1000");
assertEqual("server tax authority ignored client tax hint", scalar(`SELECT tax_fils::text FROM public.sale_items WHERE sale_id='${saleId}'::uuid AND product_id='${I.productA}'::uuid;`), "0");
assertEqual("authoritative delivery sale total", scalar(`SELECT total_fils::text FROM public.sales WHERE id='${saleId}'::uuid;`), "1000");
assertEqual("inventory decremented exactly once", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.centerA}'::uuid AND product_id='${I.productA}'::uuid;`), "2.000");
assertEqual("one sale effect", scalar(`SELECT count(*)::text FROM public.sales WHERE id='${saleId}'::uuid;`), "1");
assertEqual("one delivery effect", scalar(`SELECT count(*)::text FROM public.delivery_orders WHERE id='${orderId}'::uuid;`), "1");

const replayOrderId = asUser(I.cashierA, deliveryCall());
assertEqual("idempotent replay returns same delivery", replayOrderId, orderId);
assertEqual("idempotent replay does not duplicate sale", scalar(`SELECT count(*)::text FROM public.sales WHERE client_mutation_id='${operationId}';`), "1");
assertEqual("idempotent replay does not duplicate inventory", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${I.centerA}'::uuid AND product_id='${I.productA}'::uuid;`), "2.000");

expectReject(
  "payload-bound operation identity",
  I.cashierA,
  deliveryCall({ address: "Different Bahrain address" }),
  /different delivery request|mutation ID/i,
);
expectReject(
  "cross-tenant delivery denied",
  I.cashierA,
  deliveryCall({ op: "delivery-authority-op-0002", tenant: I.tenantB, branch: I.branchB }),
  /forbidden|branch/i,
);
expectReject(
  "negative delivery fee denied",
  I.cashierA,
  deliveryCall({ op: "delivery-authority-op-0003", feeFils: -1 }),
  /delivery fee cannot be negative/i,
);

process.stdout.write("Delivery financial-authority PostgreSQL PASS: exact fee fils, server price/tax authority, atomic sale/inventory linkage, payload-bound idempotency, and tenant/branch denial verified.\n");
