import { execFile, execFileSync } from "node:child_process";

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
assertEqual("delivery legacy numeric compatibility mirrors exact fils", scalar(`SELECT (delivery_fee = 0.250::numeric)::text FROM public.delivery_orders WHERE id='${orderId}'::uuid;`), "true");
const saleId = scalar(`SELECT sale_id::text FROM public.delivery_orders WHERE id='${orderId}'::uuid;`);
if (!/^[0-9a-f-]{36}$/i.test(saleId)) throw new Error(`delivery did not link an authoritative sale: ${saleId}`);
assertEqual("server price authority ignored client unit-price hint", scalar(`SELECT unit_price_fils::text FROM public.sale_items WHERE sale_id='${saleId}'::uuid AND product_id='${I.productA}'::uuid;`), "1000");
assertEqual("server tax authority ignored client tax hint", scalar(`SELECT (tax_rate = 0::numeric)::text FROM public.sale_items WHERE sale_id='${saleId}'::uuid AND product_id='${I.productA}'::uuid;`), "true");
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

expectReject(
  "legacy arbitrary collection is not executable",
  I.cashierA,
  `SELECT public.register_delivery_payment('${orderId}', 'cash', 999.999, 'forged-collection')`,
  /permission denied/i,
);
assertEqual("delivery direct financial mutation is revoked", scalar(`SELECT has_table_privilege('authenticated','public.delivery_orders','UPDATE');`), "f");
assertEqual("delivery collection v2 exists", scalar(`SELECT to_regprocedure('public.collect_delivery_payment_v2(uuid,public.payment_method,uuid,text,text)') IS NOT NULL;`), "t");

const outsider='3d000000-0000-0000-0000-000000000002';
const wrongBranchUser='3d000000-0000-0000-0000-000000000003';
const branchA2='2d000000-0000-0000-0000-000000000003';
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('${outsider}','delivery-outsider@zaipos.test','{}'),('${wrongBranchUser}','delivery-wrongbranch@zaipos.test','{}');
INSERT INTO public.branches(id,tenant_id,name,status) VALUES ('${branchA2}','${I.tenantA}','Other same-tenant branch','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES ('${outsider}','${I.tenantB}','${I.branchB}','cashier'),('${wrongBranchUser}','${I.tenantA}','${branchA2}','cashier');`);
expectReject('cross tenant collection denied',outsider,`SELECT public.collect_delivery_payment_v2('${orderId}','cash',NULL,'collection-outsider',NULL)`,/forbidden/i);
expectReject('wrong branch collection denied',wrongBranchUser,`SELECT public.collect_delivery_payment_v2('${orderId}','cash',NULL,'collection-wrongbranch',NULL)`,/forbidden/i);
expectReject('cross tenant courier read denied',outsider,`SELECT public.list_courier_deliveries('${I.tenantA}','${I.branchA}')`,/forbidden/i);
assertEqual('wrong branch direct delivery read isolated',asUser(wrongBranchUser,`SELECT count(*)::text FROM public.delivery_orders WHERE id='${orderId}'`),'0');
const sessionId = "6d000000-0000-0000-0000-000000000001";
sql(`INSERT INTO public.cash_sessions(id,tenant_id,branch_id,user_id) VALUES ('${sessionId}','${I.tenantA}','${I.branchA}','${I.cashierA}');`);
asUser(I.cashierA, `SELECT public.update_delivery_status('${orderId}','ready',NULL)`);
const collect = ({order=orderId, method='cash', session=sessionId, op='collection-contract-0001'}={}) =>
  `SELECT public.collect_delivery_payment_v2('${order}','${method}','${session}','${op}',NULL)::text`;
expectReject('wrong receiving session', I.cashierA, collect({session:I.branchB}), /open receiving cash session/i);
expectReject('cannot mark delivered without collection', I.cashierA, `SELECT public.update_delivery_status('${orderId}','delivered',NULL)`, /atomic delivery collection/i);
expectReject('cannot directly rewrite delivery fee', I.cashierA, `UPDATE public.delivery_orders SET delivery_fee_fils=1 WHERE id='${orderId}'`, /permission denied/i);
const collectionId=asUser(I.cashierA,collect());
assertEqual('replay returns original collection',asUser(I.cashierA,collect()),collectionId);
assertEqual('payment matches merchandise exactly, fee separate',scalar(`SELECT sum(amount_fils)::text FROM public.payments WHERE sale_id='${saleId}'`),'1000');
assertEqual('collection preserves fee and gross',scalar(`SELECT sale_amount_fils||':'||fee_amount_fils||':'||collected_fils FROM public.delivery_collections WHERE id='${collectionId}'`),'1000:250:1250');
assertEqual('receiving cash session updated exactly once',scalar(`SELECT total_cash_fils::text FROM public.cash_sessions WHERE id='${sessionId}'`),'1250');
assertEqual('collection atomically completes delivery',scalar(`SELECT status::text FROM public.delivery_orders WHERE id='${orderId}'`),'delivered');
expectReject('altered retry rejected',I.cashierA,collect({method:'card'}),/payload mismatch/i);
expectReject('new operation cannot recollect same order',I.cashierA,collect({op:'collection-contract-0002'}),/already collected/i);
expectReject('immutable collection ledger',I.cashierA,`DELETE FROM public.delivery_collections WHERE id='${collectionId}'`,/permission denied/i);
assertEqual('one collection audit',scalar(`SELECT count(*)::text FROM public.audit_logs WHERE action='delivery.collected_v2' AND entity_id='${collectionId}'`),'1');

const concurrentOrder=asUser(I.cashierA,deliveryCall({op:'delivery-concurrent-0001'}));
asUser(I.cashierA,`SELECT public.update_delivery_status('${concurrentOrder}','ready',NULL)`);
function asyncUser(statement) {
  return new Promise((resolve,reject)=>execFile('psql',[dbUrl,'-X','-v','ON_ERROR_STOP=1','-Atq','-c',`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${I.cashierA}'; ${statement}; COMMIT;`],{encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))));
}
const concurrentCall=collect({order:concurrentOrder,op:'collection-concurrent-0001',method:'qr'});
const results=await Promise.all([asyncUser(concurrentCall),asyncUser(concurrentCall)]);
assertEqual('concurrent replay converges',results[0],results[1]);
assertEqual('concurrent BenefitPay credited once',scalar(`SELECT total_qr_fils::text FROM public.cash_sessions WHERE id='${sessionId}'`),'1250');
const rollbackOrder=asUser(I.cashierA,deliveryCall({op:'delivery-rollback-0001'}));
asUser(I.cashierA,`SELECT public.update_delivery_status('${rollbackOrder}','ready',NULL)`);
expectReject('post-effect failure rolls back collection',I.cashierA,`${collect({order:rollbackOrder,op:'collection-rollback-0001'})}; SELECT 1/0`,/division by zero/i);
assertEqual('failed transaction has no collection',scalar(`SELECT count(*)::text FROM public.delivery_collections WHERE order_id='${rollbackOrder}'`),'0');
assertEqual('failed transaction leaves status ready',scalar(`SELECT status::text FROM public.delivery_orders WHERE id='${rollbackOrder}'`),'ready');
assertEqual('failed transaction leaves till unchanged',scalar(`SELECT total_cash_fils::text FROM public.cash_sessions WHERE id='${sessionId}'`),'1250');
asUser(I.cashierA,collect({order:rollbackOrder,op:'collection-rollback-0001'}));
assertEqual('failed transaction retry converges',scalar(`SELECT total_cash_fils::text FROM public.cash_sessions WHERE id='${sessionId}'`),'2500');
// Exercise courier-specific authorization, exact one-fils precision and all methods.
const courier='3d000000-0000-0000-0000-000000000004';
const courierOther='3d000000-0000-0000-0000-000000000005';
const employee='7d000000-0000-0000-0000-000000000001';
sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('${courier}','delivery-courier@zaipos.test','{}'),('${courierOther}','delivery-unassigned@zaipos.test','{}');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES ('${courier}','${I.tenantA}','${I.branchA}','courier'),('${courierOther}','${I.tenantA}','${I.branchA}','courier');
INSERT INTO public.employees(id,tenant_id,branch_id,user_id,full_name,role,status) VALUES ('${employee}','${I.tenantA}','${I.branchA}','${courier}','Contract courier','courier','active');
UPDATE public.inventory_stocks SET quantity=5.000 WHERE inventory_center_id='${I.centerA}' AND product_id='${I.productA}';`);
const courierOrder=asUser(I.cashierA,deliveryCall({op:'delivery-courier-0001',feeFils:251}));
asUser(I.cashierA,`SELECT public.update_delivery_status('${courierOrder}','assigned','${employee}')`);
const courierCall=collect({order:courierOrder,method:'card',op:'collection-courier-0001'});
expectReject('unassigned courier denied',courierOther,courierCall,/forbidden/i);
assertEqual('assigned courier can read only their order',asUser(courier,`SELECT jsonb_array_length(public.list_courier_deliveries('${I.tenantA}','${I.branchA}')->'orders')::text`),'1');
assertEqual('unassigned courier sees no customer orders',asUser(courierOther,`SELECT jsonb_array_length(public.list_courier_deliveries('${I.tenantA}','${I.branchA}')->'orders')::text`),'0');
assertEqual('assigned courier direct read uses private employee authorization safely',asUser(courier,`SELECT count(*)::text FROM public.delivery_orders WHERE id='${courierOrder}'`),'1');
sql(`UPDATE public.employees SET status='inactive' WHERE id='${employee}';`);
expectReject('inactive courier cannot collect',courier,courierCall,/forbidden/i);
sql(`UPDATE public.employees SET status='active' WHERE id='${employee}';`);
asUser(courier,courierCall);
assertEqual('card collection preserves a single fils',scalar(`SELECT total_card_fils::text FROM public.cash_sessions WHERE id='${sessionId}'`),'1251');
const transferOrder=asUser(I.cashierA,deliveryCall({op:'delivery-transfer-0001',feeFils:251}));
asUser(I.cashierA,`SELECT public.update_delivery_status('${transferOrder}','ready',NULL)`);
asUser(I.cashierA,collect({order:transferOrder,method:'transfer',op:'collection-transfer-0001'}));
assertEqual('transfer collection preserves a single fils',scalar(`SELECT total_transfer_fils::text FROM public.cash_sessions WHERE id='${sessionId}'`),'1251');
sql(`UPDATE public.cash_sessions SET status='closed' WHERE id='${sessionId}';`);
assertEqual('lost response retry survives later till closure',asUser(I.cashierA,collect()),collectionId);
assertEqual('courier read model exposes exact strings',asUser(I.cashierA,`SELECT jsonb_typeof(public.list_courier_deliveries('${I.tenantA}','${I.branchA}')->'orders'->0->'collection_total_fils')`),'string');
sql(`DELETE FROM public.user_roles WHERE user_id='${I.cashierA}' AND tenant_id='${I.tenantA}';`);
expectReject('revoked actor cannot replay collection',I.cashierA,collect(),/forbidden/i);

process.stdout.write("Delivery financial-authority PostgreSQL PASS: exact fee fils, server price/tax authority, atomic sale/inventory linkage, payload-bound idempotency, and tenant/branch denial verified.\n");
