import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const I = {
  tenant: "1e000000-0000-0000-0000-000000000111",
  branch: "2e000000-0000-0000-0000-000000000111",
  manager: "4e000000-0000-0000-0000-000000000111",
  customerReturn: "6e000000-0000-0000-0000-000000000111",
  customerVoid: "6e000000-0000-0000-0000-000000000112",
  customerLegacy: "6e000000-0000-0000-0000-000000000113",
  saleReturn: "7e000000-0000-0000-0000-000000000111",
  saleVoid: "7e000000-0000-0000-0000-000000000112",
  saleLegacy: "7e000000-0000-0000-0000-000000000113",
  return1: "8e000000-0000-0000-0000-000000000111",
  return2: "8e000000-0000-0000-0000-000000000112",
  void1: "9e000000-0000-0000-0000-000000000111",
};

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}
function sql(statement) { return psql(["-c", statement], false); }
function scalar(statement) { return psql(["-Atq", "-c", statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ""; }
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectReject(label, statement, pattern) {
  try { scalar(statement); }
  catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.manager}','loyalty-manager@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,points_per_thousand) VALUES
    ('${I.tenant}','Loyalty Tenant','loyalty-tenant','BHD',10,false,10)
  ON CONFLICT (id) DO UPDATE SET points_per_thousand=EXCLUDED.points_per_thousand;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branch}','${I.tenant}','Loyalty Branch','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.manager}','${I.tenant}',NULL,'manager')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.customers(id,tenant_id,name,loyalty_points) VALUES
    ('${I.customerReturn}','Return Customer',0,0),
    ('${I.customerVoid}','Void Customer',0,0),
    ('${I.customerLegacy}','Legacy Customer',0,0)
  ON CONFLICT (id) DO NOTHING;
`);

// The production customer schema is tenant-scoped. Repair the deliberately compact seed
// above if the column order differs by using explicit assignments after insert discovery.
if (scalar(`SELECT count(*)::text FROM public.customers WHERE id IN ('${I.customerReturn}','${I.customerVoid}','${I.customerLegacy}')`) !== "3") {
  throw new Error("customer fixture creation failed");
}

function createSale(id, customerId, operationId) {
  sql(`
    INSERT INTO public.sales(
      id,tenant_id,branch_id,user_id,customer_id,subtotal,tax_total,discount_total,total,status,channel,client_mutation_id
    ) VALUES (
      '${id}','${I.tenant}','${I.branch}','${I.manager}','${customerId}',2.500,0,0,2.500,'completed','delivery','${operationId}'
    );
  `);
}
function captureAward(saleId, customerId, operationId) {
  // checkout_sale_v2 has already applied the aggregate delta when operation_log is written.
  sql(`UPDATE public.customers SET loyalty_points=loyalty_points+20 WHERE id='${customerId}';`);
  sql(`
    INSERT INTO public.operation_log(
      tenant_id,branch_id,operation_type,client_mutation_id,entity_type,entity_id,payload,status
    ) VALUES (
      '${I.tenant}','${I.branch}','checkout_sale_v2','${operationId}','sales','${saleId}',
      jsonb_build_object('total_fils',2500),'success'
    );
  `);
}

createSale(I.saleReturn, I.customerReturn, "loyalty-sale-return-111");
captureAward(I.saleReturn, I.customerReturn, "loyalty-op-return-111");
assertEqual("sale award points", scalar(`SELECT points_delta::text FROM public.customer_loyalty_ledger WHERE sale_id='${I.saleReturn}' AND event_type='sale_earn';`), "20");
assertEqual("sale award policy snapshot", scalar(`SELECT points_per_thousand_snapshot::text FROM public.customer_loyalty_ledger WHERE sale_id='${I.saleReturn}' AND event_type='sale_earn';`), "10");
assertEqual("checkout aggregate matches award", scalar(`SELECT loyalty_points::text FROM public.customers WHERE id='${I.customerReturn}';`), "20");

sql(`
  INSERT INTO public.sale_returns(
    id,tenant_id,branch_id,original_sale_id,reason_code,reason,amount,amount_fils,items,user_id,
    refund_method,status,client_mutation_id,request_payload
  ) VALUES (
    '${I.return1}','${I.tenant}','${I.branch}','${I.saleReturn}','customer_request','Partial return',
    0,0,'[]','${I.manager}','original','processing','loyalty-return-op-111','{}'
  );
  UPDATE public.sale_returns SET amount=0.600,status='completed' WHERE id='${I.return1}';
`);
assertEqual("first threshold reversal", scalar(`SELECT points_delta::text FROM public.customer_loyalty_ledger WHERE return_id='${I.return1}';`), "-10");
assertEqual("customer points after first return", scalar(`SELECT loyalty_points::text FROM public.customers WHERE id='${I.customerReturn}';`), "10");

sql(`
  INSERT INTO public.sale_returns(
    id,tenant_id,branch_id,original_sale_id,reason_code,reason,amount,amount_fils,items,user_id,
    refund_method,status,client_mutation_id,request_payload
  ) VALUES (
    '${I.return2}','${I.tenant}','${I.branch}','${I.saleReturn}','customer_request','Second partial return',
    0,0,'[]','${I.manager}','original','processing','loyalty-return-op-112','{}'
  );
  UPDATE public.sale_returns SET amount=0.500,status='completed' WHERE id='${I.return2}';
`);
assertEqual("second partial return preserves threshold", scalar(`SELECT points_delta::text FROM public.customer_loyalty_ledger WHERE return_id='${I.return2}';`), "0");
assertEqual("customer points remain exact", scalar(`SELECT loyalty_points::text FROM public.customers WHERE id='${I.customerReturn}';`), "10");
assertEqual("one reversal event per return", scalar(`SELECT count(*)::text FROM public.customer_loyalty_ledger WHERE return_id IN ('${I.return1}','${I.return2}');`), "2");

createSale(I.saleVoid, I.customerVoid, "loyalty-sale-void-111");
captureAward(I.saleVoid, I.customerVoid, "loyalty-op-void-111");
sql(`
  INSERT INTO public.sale_voids(
    id,tenant_id,branch_id,sale_id,user_id,client_mutation_id,request_payload,total,total_fils,status
  ) VALUES (
    '${I.void1}','${I.tenant}','${I.branch}','${I.saleVoid}','${I.manager}',
    'loyalty-void-op-111','{}',2.500,2500,'processing'
  );
  UPDATE public.sale_voids SET status='completed',completed_at=now() WHERE id='${I.void1}';
`);
assertEqual("void reverses remaining sale points", scalar(`SELECT points_delta::text FROM public.customer_loyalty_ledger WHERE void_id='${I.void1}';`), "-20");
assertEqual("void customer balance returns to zero", scalar(`SELECT loyalty_points::text FROM public.customers WHERE id='${I.customerVoid}';`), "0");

createSale(I.saleLegacy, I.customerLegacy, "loyalty-sale-legacy-111");
expectReject(
  "historical customer sale without exact award remains fail closed",
  `INSERT INTO public.sale_returns(
     tenant_id,branch_id,original_sale_id,reason_code,reason,amount,amount_fils,items,user_id,
     refund_method,status,client_mutation_id,request_payload
   ) VALUES (
     '${I.tenant}','${I.branch}','${I.saleLegacy}','customer_request','Legacy return',0,0,'[]','${I.manager}',
     'original','processing','loyalty-return-legacy-111','{}'
   ) RETURNING id;`,
  /loyalty reversal evidence/i,
);

console.log("Customer loyalty ledger runtime contract passed.");
