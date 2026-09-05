import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("../supabase/migrations/20260905102000_return_customer_loyalty_guard.sql", import.meta.url);
let migration;
try {
  migration = await readFile(migrationUrl, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error("P0.6 migration missing: customer-linked return loyalty guard is not implemented");
  }
  throw error;
}

const db = new PGlite();

try {
  await db.exec(`
    CREATE TABLE public.sales (
      id uuid PRIMARY KEY,
      customer_id uuid
    );
    CREATE TABLE public.sale_returns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      original_sale_id uuid NOT NULL REFERENCES public.sales(id),
      status text NOT NULL DEFAULT 'processing'
    );

    INSERT INTO public.sales (id, customer_id) VALUES
      ('60000000-0000-0000-0000-000000000001', NULL),
      ('60000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000001');
  `);

  await db.exec(migration);

  await db.exec(`
    INSERT INTO public.sale_returns (original_sale_id)
    VALUES ('60000000-0000-0000-0000-000000000001');
  `);

  let rejected = false;
  try {
    await db.exec(`
      INSERT INTO public.sale_returns (original_sale_id)
      VALUES ('60000000-0000-0000-0000-000000000002');
    `);
  } catch (error) {
    rejected = true;
    const message = String(error?.message ?? error);
    if (!message.toLowerCase().includes("loyalty reversal evidence")) {
      throw new Error(`customer return guard failed with wrong error: ${message}`);
    }
  }

  if (!rejected) {
    throw new Error("customer-linked return was accepted without loyalty reversal evidence");
  }

  const result = await db.query(`SELECT count(*)::int AS count FROM public.sale_returns`);
  if (result.rows[0].count !== 1) {
    throw new Error(`guard changed non-customer return behavior: ${JSON.stringify(result.rows[0])}`);
  }

  console.log("PASS: customer-linked returns fail closed until exact loyalty reversal evidence exists.");
} finally {
  await db.close();
}
