import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = path.join(root, "supabase", "migrations");
const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const baselineFile = "20260904000120_migrate_inherited_demo_to_bahrain.sql";
const baselineIndex = migrations.indexOf(baselineFile);

if (baselineIndex < 0) throw new Error(`Supported baseline migration is missing: ${baselineFile}`);
if (migrations.length < 55) throw new Error(`Expected at least 55 migrations, found ${migrations.length}`);

const adminUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

function databaseUrl(name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function psql(database, args = [], options = {}) {
  return execFileSync("psql", [databaseUrl(database), "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, PGPASSWORD: "postgres" },
  });
}

function sql(database, statement, { capture = false } = {}) {
  return psql(database, ["-c", statement], { capture });
}

function scalar(database, statement) {
  return psql(database, ["-At", "-c", statement], { capture: true }).trim();
}

function createClusterRoles() {
  sql("postgres", `
    DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
}

function recreateDatabase(name) {
  sql("postgres", `DROP DATABASE IF EXISTS ${name} WITH (FORCE);`);
  sql("postgres", `CREATE DATABASE ${name};`);
  sql(name, `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE PUBLICATION supabase_realtime;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid,
      aud text,
      role text,
      email text,
      encrypted_password text,
      email_confirmed_at timestamptz,
      invited_at timestamptz,
      confirmation_token text,
      confirmation_sent_at timestamptz,
      recovery_token text,
      recovery_sent_at timestamptz,
      email_change_token_new text,
      email_change text,
      email_change_sent_at timestamptz,
      last_sign_in_at timestamptz,
      raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      is_super_admin boolean,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      phone text,
      phone_confirmed_at timestamptz,
      phone_change text DEFAULT '',
      phone_change_token text DEFAULT '',
      phone_change_sent_at timestamptz,
      email_change_token_current text DEFAULT '',
      email_change_confirm_status smallint DEFAULT 0,
      banned_until timestamptz,
      reauthentication_token text DEFAULT '',
      reauthentication_sent_at timestamptz,
      is_sso_user boolean NOT NULL DEFAULT false,
      deleted_at timestamptz,
      is_anonymous boolean NOT NULL DEFAULT false
    );
    CREATE OR REPLACE FUNCTION auth.uid()
    RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE OR REPLACE FUNCTION auth.jwt()
    RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  `);
}

function apply(database, filenames) {
  for (const name of filenames) {
    process.stdout.write(`[migration:${database}] ${name}\n`);
    psql(database, ["-f", path.join(migrationsDir, name)]);
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function seedSupportedBaseline(database) {
  sql(database, `
    INSERT INTO auth.users(id, email, raw_user_meta_data)
    VALUES ('30000000-0000-0000-0000-000000000091', 'upgrade@zaipos.test', '{"full_name":"Upgrade User"}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.tenants(id, name, slug, currency, tax_rate, dev_mode)
    VALUES ('10000000-0000-0000-0000-000000000091', 'Upgrade Tenant', 'upgrade-tenant', 'BHD', 10, false);

    INSERT INTO public.branches(id, tenant_id, name, status)
    VALUES ('20000000-0000-0000-0000-000000000091', '10000000-0000-0000-0000-000000000091', 'Upgrade Branch', 'active');

    INSERT INTO public.user_roles(user_id, tenant_id, branch_id, role)
    VALUES ('30000000-0000-0000-0000-000000000091', '10000000-0000-0000-0000-000000000091', '20000000-0000-0000-0000-000000000091', 'owner');

    INSERT INTO public.cash_sessions(
      id, tenant_id, branch_id, user_id, opening_amount, total_cash, total_card, total_transfer, total_qr, status
    ) VALUES (
      '40000000-0000-0000-0000-000000000091', '10000000-0000-0000-0000-000000000091',
      '20000000-0000-0000-0000-000000000091', '30000000-0000-0000-0000-000000000091',
      10.00, 2.50, 0, 0, 0, 'open'
    );

    INSERT INTO public.products(id, tenant_id, name, product_type, price, cost, tax_rate, status)
    VALUES ('50000000-0000-0000-0000-000000000091', '10000000-0000-0000-0000-000000000091', 'Upgrade Product', 'simple', 1.25, 0.75, 0, 'active');

    INSERT INTO public.inventory_stocks(tenant_id, branch_id, product_id, quantity)
    VALUES ('10000000-0000-0000-0000-000000000091', '20000000-0000-0000-0000-000000000091', '50000000-0000-0000-0000-000000000091', 7.500);

    INSERT INTO public.sales(
      id, tenant_id, branch_id, session_id, user_id, subtotal, tax_total, discount_total, total, status, channel, client_mutation_id
    ) VALUES (
      '60000000-0000-0000-0000-000000000091', '10000000-0000-0000-0000-000000000091',
      '20000000-0000-0000-0000-000000000091', '40000000-0000-0000-0000-000000000091',
      '30000000-0000-0000-0000-000000000091', 2.50, 0, 0, 2.50, 'completed', 'pos', 'supported-upgrade-sale'
    );

    INSERT INTO public.sale_items(
      id, tenant_id, sale_id, product_id, product_name, product_type, quantity, unit_price, tax_rate, discount, line_total
    ) VALUES (
      '70000000-0000-0000-0000-000000000091', '10000000-0000-0000-0000-000000000091',
      '60000000-0000-0000-0000-000000000091', '50000000-0000-0000-0000-000000000091',
      'Upgrade Product', 'simple', 2.000, 1.25, 0, 0, 2.50
    );

    INSERT INTO public.payments(id, tenant_id, sale_id, method, amount, reference)
    VALUES (
      '80000000-0000-0000-0000-000000000091', '10000000-0000-0000-0000-000000000091',
      '60000000-0000-0000-0000-000000000091', 'cash', 2.50, 'UPGRADE-CASH'
    );
  `);
}

function verifyFinalShape(database) {
  const required = [
    "public.checkout_sale_v2(uuid,uuid,jsonb,jsonb,bigint,text,uuid,public.sales_channel,bigint,text,text,uuid)",
    "public.process_sale_return_v2(uuid,jsonb,text,text,uuid,text,text)",
    "public.process_sale_void_v2(uuid,text,uuid,text)",
    "public.record_inventory_batch_v2(uuid,uuid,uuid,jsonb,text,text)",
    "public.reconcile_inventory_levels_v2(uuid,uuid,uuid,jsonb,text,text)",
  ];
  for (const signature of required) {
    assertEqual(`required function ${signature}`, scalar(database, `SELECT to_regprocedure('${signature}') IS NOT NULL;`), "t");
  }
  for (const table of ["checkout_operations", "sale_return_items", "payment_refunds", "sale_voids", "payment_voids", "inventory_operations"]) {
    assertEqual(`required table ${table}`, scalar(database, `SELECT to_regclass('public.${table}') IS NOT NULL;`), "t");
  }
}

createClusterRoles();

recreateDatabase("zaipos_clean");
apply("zaipos_clean", migrations);
verifyFinalShape("zaipos_clean");
assertEqual("clean install seeded Bahrain currency", scalar("zaipos_clean", "SELECT count(*)::text FROM public.tenants WHERE currency='BHD';"), "1");

recreateDatabase("zaipos_upgrade");
apply("zaipos_upgrade", migrations.slice(0, baselineIndex + 1));
seedSupportedBaseline("zaipos_upgrade");
apply("zaipos_upgrade", migrations.slice(baselineIndex + 1));
verifyFinalShape("zaipos_upgrade");

assertEqual("upgrade product price", scalar("zaipos_upgrade", "SELECT price::text FROM public.products WHERE id='50000000-0000-0000-0000-000000000091';"), "1.250");
assertEqual("upgrade product price fils", scalar("zaipos_upgrade", "SELECT price_fils::text FROM public.products WHERE id='50000000-0000-0000-0000-000000000091';"), "1250");
assertEqual("upgrade product cost fils", scalar("zaipos_upgrade", "SELECT cost_fils::text FROM public.products WHERE id='50000000-0000-0000-0000-000000000091';"), "750");
assertEqual("upgrade sale total fils", scalar("zaipos_upgrade", "SELECT total_fils::text FROM public.sales WHERE id='60000000-0000-0000-0000-000000000091';"), "2500");
assertEqual("upgrade sale item unit price fils", scalar("zaipos_upgrade", "SELECT unit_price_fils::text FROM public.sale_items WHERE id='70000000-0000-0000-0000-000000000091';"), "1250");
assertEqual("upgrade payment amount fils", scalar("zaipos_upgrade", "SELECT amount_fils::text FROM public.payments WHERE id='80000000-0000-0000-0000-000000000091';"), "2500");
assertEqual("upgrade opening cash fils", scalar("zaipos_upgrade", "SELECT opening_amount_fils::text FROM public.cash_sessions WHERE id='40000000-0000-0000-0000-000000000091';"), "10000");
assertEqual("upgrade till cash fils", scalar("zaipos_upgrade", "SELECT total_cash_fils::text FROM public.cash_sessions WHERE id='40000000-0000-0000-0000-000000000091';"), "2500");
assertEqual("upgrade stock quantity preserved", scalar("zaipos_upgrade", "SELECT quantity::text FROM public.inventory_stocks WHERE branch_id='20000000-0000-0000-0000-000000000091' AND product_id='50000000-0000-0000-0000-000000000091';"), "7.500");

process.stdout.write(`Production PostgreSQL migration chain PASS: clean=${migrations.length} migrations; supported baseline=${baselineFile}\n`);
