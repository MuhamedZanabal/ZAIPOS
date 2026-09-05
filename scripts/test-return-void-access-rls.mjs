import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../supabase/migrations/20260905103000_return_void_access_hardening.sql",
  import.meta.url,
);
let migration;
try {
  migration = await readFile(migrationUrl, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error("P0.6 migration missing: return/void direct-access hardening is not implemented");
  }
  throw error;
}

const db = new PGlite();

const IDS = {
  tenant: "10000000-0000-0000-0000-000000000001",
  branchA: "20000000-0000-0000-0000-000000000001",
  branchB: "20000000-0000-0000-0000-000000000002",
  managerA: "30000000-0000-0000-0000-000000000001",
  managerB: "30000000-0000-0000-0000-000000000002",
  owner: "30000000-0000-0000-0000-000000000003",
  cashier: "30000000-0000-0000-0000-000000000004",
  outsider: "30000000-0000-0000-0000-000000000005",
};

const TABLES = [
  "sale_returns",
  "sale_return_items",
  "payment_refunds",
  "sale_voids",
  "sale_void_items",
  "payment_voids",
];

async function asUser(userId) {
  await db.exec(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
}

async function visibleBranches(table, userId) {
  await asUser(userId);
  const result = await db.query(`SELECT branch_id FROM public.${table} ORDER BY branch_id`);
  return result.rows.map((row) => row.branch_id);
}

async function expectDenied(label, sql) {
  let denied = false;
  try {
    await db.exec(sql);
  } catch (error) {
    denied = true;
    const message = String(error?.message ?? error).toLowerCase();
    if (!message.includes("permission denied") && !message.includes("row-level security")) {
      throw new Error(`${label}: expected privilege/RLS denial, got ${message}`);
    }
  }
  if (!denied) throw new Error(`${label}: direct mutation unexpectedly succeeded`);
}

try {
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE anon;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO authenticated;

    CREATE OR REPLACE FUNCTION auth.uid()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    CREATE TYPE public.app_role AS ENUM (
      'super_admin','owner','admin','manager','cashier','kitchen','inventory','courier','staff','waiter'
    );

    CREATE TABLE public.tenants (id uuid PRIMARY KEY);
    CREATE TABLE public.branches (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id)
    );
    CREATE TABLE public.user_roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid REFERENCES public.branches(id),
      role public.app_role NOT NULL
    );

    CREATE OR REPLACE FUNCTION public.has_branch_role(
      _user_id uuid,
      _tenant_id uuid,
      _branch_id uuid,
      _roles public.app_role[]
    ) RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $$
      SELECT EXISTS (
        SELECT 1
        FROM public.user_roles
        WHERE user_id = _user_id
          AND tenant_id = _tenant_id
          AND role = ANY(_roles)
          AND (branch_id IS NULL OR branch_id = _branch_id)
      )
    $$;

    ${TABLES.map((table) => `
      CREATE TABLE public.${table} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES public.tenants(id),
        branch_id uuid NOT NULL REFERENCES public.branches(id)
      );
    `).join("\n")}

    INSERT INTO public.tenants(id) VALUES ('${IDS.tenant}');
    INSERT INTO public.branches(id, tenant_id) VALUES
      ('${IDS.branchA}', '${IDS.tenant}'),
      ('${IDS.branchB}', '${IDS.tenant}');
    INSERT INTO public.user_roles(user_id, tenant_id, branch_id, role) VALUES
      ('${IDS.managerA}', '${IDS.tenant}', '${IDS.branchA}', 'manager'),
      ('${IDS.managerB}', '${IDS.tenant}', '${IDS.branchB}', 'manager'),
      ('${IDS.owner}', '${IDS.tenant}', NULL, 'owner'),
      ('${IDS.cashier}', '${IDS.tenant}', '${IDS.branchA}', 'cashier');

    ${TABLES.map((table) => `
      INSERT INTO public.${table}(tenant_id, branch_id) VALUES
        ('${IDS.tenant}', '${IDS.branchA}'),
        ('${IDS.tenant}', '${IDS.branchB}');
    `).join("\n")}
  `);

  await db.exec(migration);
  await db.exec("SET ROLE authenticated;");

  for (const table of TABLES) {
    const managerAVisible = await visibleBranches(table, IDS.managerA);
    if (managerAVisible.length !== 1 || managerAVisible[0] !== IDS.branchA) {
      throw new Error(`${table}: Branch A manager RLS leak: ${JSON.stringify(managerAVisible)}`);
    }

    const managerBVisible = await visibleBranches(table, IDS.managerB);
    if (managerBVisible.length !== 1 || managerBVisible[0] !== IDS.branchB) {
      throw new Error(`${table}: Branch B manager RLS leak: ${JSON.stringify(managerBVisible)}`);
    }

    const ownerVisible = await visibleBranches(table, IDS.owner);
    if (ownerVisible.length !== 2) {
      throw new Error(`${table}: tenant owner should see both branch rows: ${JSON.stringify(ownerVisible)}`);
    }

    const cashierVisible = await visibleBranches(table, IDS.cashier);
    if (cashierVisible.length !== 0) {
      throw new Error(`${table}: cashier can observe restricted compensation evidence: ${JSON.stringify(cashierVisible)}`);
    }

    const outsiderVisible = await visibleBranches(table, IDS.outsider);
    if (outsiderVisible.length !== 0) {
      throw new Error(`${table}: outsider can observe compensation evidence: ${JSON.stringify(outsiderVisible)}`);
    }

    await asUser(IDS.managerA);
    await expectDenied(
      `${table} direct insert`,
      `INSERT INTO public.${table}(tenant_id, branch_id) VALUES ('${IDS.tenant}', '${IDS.branchA}')`,
    );
    await expectDenied(
      `${table} direct update`,
      `UPDATE public.${table} SET branch_id = '${IDS.branchB}' WHERE branch_id = '${IDS.branchA}'`,
    );
    await expectDenied(
      `${table} direct delete`,
      `DELETE FROM public.${table} WHERE branch_id = '${IDS.branchA}'`,
    );
  }

  console.log("PASS: return/void evidence is manager-scoped by branch and authenticated clients cannot directly mutate compensation ledgers.");
} finally {
  await db.close();
}
