import { spawn, execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

const IDS = {
  tenant: "10000000-0000-0000-0000-000000000099",
  branch: "20000000-0000-0000-0000-000000000099",
  cashier: "30000000-0000-0000-0000-000000000099",
  session: "40000000-0000-0000-0000-000000000099",
  center: "45000000-0000-0000-0000-000000000099",
  product: "50000000-0000-0000-0000-000000000099",
};

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function sql(statement) {
  return psql(["-c", statement], false);
}

function scalar(statement) {
  return psql(["-At", "-c", statement]).trim();
}

function checkoutSql(operationId) {
  const items = [{ product_id: IDS.product, quantity: "1.000", discount_fils: 0 }];
  const payments = [{ method: "cash", amount_fils: 1000, reference: null }];
  return `
    SET request.jwt.claim.sub = '${IDS.cashier}';
    SELECT public.checkout_sale_v2(
      '${IDS.tenant}'::uuid,
      '${IDS.branch}'::uuid,
      '${JSON.stringify(items)}'::jsonb,
      '${JSON.stringify(payments)}'::jsonb,
      0::bigint,
      NULL,
      NULL::uuid,
      'pos'::public.sales_channel,
      0::bigint,
      NULL,
      '${operationId}',
      '${IDS.session}'::uuid
    );
  `;
}

function concurrentCheckout(operationId) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", checkoutSql(operationId)], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        resolve(lines.at(-1));
      } else {
        reject(new Error(stderr || stdout || `psql exited ${code}`));
      }
    });
  });
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

sql(`
  DELETE FROM public.checkout_operations WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.audit_logs WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.inventory_movements WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.payments WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.sale_items WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.sales WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.inventory_stocks WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.cash_sessions WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.user_roles WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.inventory_centers WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.products WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.branches WHERE tenant_id='${IDS.tenant}'::uuid;
  DELETE FROM public.tenants WHERE id='${IDS.tenant}'::uuid;
  DELETE FROM auth.users WHERE id='${IDS.cashier}'::uuid;

  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES ('${IDS.cashier}','concurrency@zaipos.test','{"full_name":"Concurrency Cashier"}');
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode,allow_negative_stock)
  VALUES ('${IDS.tenant}','Concurrency Tenant','concurrency-tenant','BHD',10,false,false);
  INSERT INTO public.branches(id,tenant_id,name,status)
  VALUES ('${IDS.branch}','${IDS.tenant}','Concurrency Branch','active');
  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role)
  VALUES ('${IDS.cashier}','${IDS.tenant}','${IDS.branch}','cashier');
  INSERT INTO public.cash_sessions(id,tenant_id,branch_id,user_id,status)
  VALUES ('${IDS.session}','${IDS.tenant}','${IDS.branch}','${IDS.cashier}','open');
  INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status)
  VALUES ('${IDS.center}','${IDS.tenant}','${IDS.branch}','Concurrency POS','point_of_sale','active');
  INSERT INTO public.products(id,tenant_id,name,product_type,price,cost,tax_rate,status)
  VALUES ('${IDS.product}','${IDS.tenant}','Last Unit Product','simple',1.000,0.500,0,'active');
  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity)
  VALUES ('${IDS.tenant}','${IDS.branch}','${IDS.center}','${IDS.product}',1.000);
`);

// Two independent connections race for one unit. Exactly one may commit.
const stockRace = await Promise.allSettled([
  concurrentCheckout("checkout-race-stock-a"),
  concurrentCheckout("checkout-race-stock-b"),
]);
const stockWinners = stockRace.filter((result) => result.status === "fulfilled");
const stockLosers = stockRace.filter((result) => result.status === "rejected");
if (stockWinners.length !== 1 || stockLosers.length !== 1) {
  throw new Error(`one-unit stock race expected 1 commit/1 rejection: ${JSON.stringify(stockRace.map((r) => r.status))}`);
}
const loserMessage = String(stockLosers[0].reason?.message ?? stockLosers[0].reason);
if (!/stock|insuficiente/i.test(loserMessage)) {
  throw new Error(`stock-race loser failed for the wrong reason: ${loserMessage}`);
}
assertEqual("stock after contention", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${IDS.center}' AND product_id='${IDS.product}';`), "0.000");
assertEqual("sales after contention", scalar(`SELECT count(*)::text FROM public.sales WHERE tenant_id='${IDS.tenant}' AND client_mutation_id IN ('checkout-race-stock-a','checkout-race-stock-b');`), "1");
assertEqual("payments after contention", scalar(`SELECT count(*)::text FROM public.payments p JOIN public.sales s ON s.id=p.sale_id WHERE s.tenant_id='${IDS.tenant}' AND s.client_mutation_id IN ('checkout-race-stock-a','checkout-race-stock-b');`), "1");
assertEqual("stock movements after contention", scalar(`SELECT count(*)::text FROM public.inventory_movements WHERE tenant_id='${IDS.tenant}' AND movement_type='sale';`), "1");
assertEqual("cash bucket after contention", scalar(`SELECT total_cash_fils::text FROM public.cash_sessions WHERE id='${IDS.session}';`), "1000");

// Reset business state and race an identical idempotency key from two connections.
sql(`
  UPDATE public.inventory_stocks SET quantity=1.000 WHERE inventory_center_id='${IDS.center}' AND product_id='${IDS.product}';
  UPDATE public.cash_sessions SET total_cash=0,total_cash_fils=0 WHERE id='${IDS.session}';
  DELETE FROM public.inventory_movements WHERE tenant_id='${IDS.tenant}';
  DELETE FROM public.payments WHERE sale_id IN (SELECT id FROM public.sales WHERE tenant_id='${IDS.tenant}');
  DELETE FROM public.sale_items WHERE sale_id IN (SELECT id FROM public.sales WHERE tenant_id='${IDS.tenant}');
  DELETE FROM public.sales WHERE tenant_id='${IDS.tenant}';
  DELETE FROM public.checkout_operations WHERE tenant_id='${IDS.tenant}';
`);

const replayRace = await Promise.all([
  concurrentCheckout("checkout-race-same-operation"),
  concurrentCheckout("checkout-race-same-operation"),
]);
if (!replayRace[0] || replayRace[0] !== replayRace[1]) {
  throw new Error(`same-operation race did not converge to one sale: ${JSON.stringify(replayRace)}`);
}
assertEqual("same-operation sales", scalar(`SELECT count(*)::text FROM public.sales WHERE tenant_id='${IDS.tenant}' AND client_mutation_id='checkout-race-same-operation';`), "1");
assertEqual("same-operation payment effects", scalar(`SELECT count(*)::text FROM public.payments WHERE sale_id='${replayRace[0]}'::uuid;`), "1");
assertEqual("same-operation inventory effects", scalar(`SELECT count(*)::text FROM public.inventory_movements WHERE reference_id='${replayRace[0]}'::uuid AND movement_type='sale';`), "1");
assertEqual("same-operation final stock", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE inventory_center_id='${IDS.center}' AND product_id='${IDS.product}';`), "0.000");
assertEqual("same-operation cash bucket", scalar(`SELECT total_cash_fils::text FROM public.cash_sessions WHERE id='${IDS.session}';`), "1000");
assertEqual("same-operation audit", scalar(`SELECT count(*)::text FROM public.audit_logs WHERE tenant_id='${IDS.tenant}' AND action='sale.checkout_committed' AND entity_id='${replayRace[0]}'::uuid;`), "1");

process.stdout.write("Real PostgreSQL checkout concurrency PASS: one-unit contention and concurrent idempotent replay are exactly-once.\n");
