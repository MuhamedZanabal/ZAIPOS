import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("../supabase/migrations/20260905034000_checkout_operations_branch_rls.sql", import.meta.url),
  "utf8",
);

const db = new PGlite();

const IDS = {
  tenant: "10000000-0000-0000-0000-000000000001",
  branchA: "20000000-0000-0000-0000-000000000001",
  branchB: "20000000-0000-0000-0000-000000000002",
  managerA: "30000000-0000-0000-0000-000000000001",
  managerB: "30000000-0000-0000-0000-000000000002",
  owner: "30000000-0000-0000-0000-000000000003",
  outsider: "30000000-0000-0000-0000-000000000004",
};

async function visibleBranches(userId) {
  await db.exec(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
  const result = await db.query(`SELECT branch_id FROM public.checkout_operations ORDER BY branch_id`);
  return result.rows.map((row) => row.branch_id);
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

    CREATE TABLE public.checkout_operations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id),
      branch_id uuid NOT NULL REFERENCES public.branches(id),
      client_mutation_id text NOT NULL
    );
    ALTER TABLE public.checkout_operations ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.checkout_operations FROM PUBLIC, anon;
    GRANT SELECT ON public.checkout_operations TO authenticated;

    INSERT INTO public.tenants(id) VALUES ('${IDS.tenant}');
    INSERT INTO public.branches(id, tenant_id) VALUES
      ('${IDS.branchA}', '${IDS.tenant}'),
      ('${IDS.branchB}', '${IDS.tenant}');
    INSERT INTO public.user_roles(user_id, tenant_id, branch_id, role) VALUES
      ('${IDS.managerA}', '${IDS.tenant}', '${IDS.branchA}', 'manager'),
      ('${IDS.managerB}', '${IDS.tenant}', '${IDS.branchB}', 'manager'),
      ('${IDS.owner}', '${IDS.tenant}', NULL, 'owner');
    INSERT INTO public.checkout_operations(tenant_id, branch_id, client_mutation_id) VALUES
      ('${IDS.tenant}', '${IDS.branchA}', 'branch-a-op'),
      ('${IDS.tenant}', '${IDS.branchB}', 'branch-b-op');
  `);

  await db.exec(migration);
  await db.exec("SET ROLE authenticated;");

  const managerAVisible = await visibleBranches(IDS.managerA);
  if (managerAVisible.length !== 1 || managerAVisible[0] !== IDS.branchA) {
    throw new Error(`Branch A manager RLS leak: ${JSON.stringify(managerAVisible)}`);
  }

  const managerBVisible = await visibleBranches(IDS.managerB);
  if (managerBVisible.length !== 1 || managerBVisible[0] !== IDS.branchB) {
    throw new Error(`Branch B manager RLS leak: ${JSON.stringify(managerBVisible)}`);
  }

  const ownerVisible = await visibleBranches(IDS.owner);
  if (ownerVisible.length !== 2) {
    throw new Error(`Tenant owner should see both branch operations: ${JSON.stringify(ownerVisible)}`);
  }

  const outsiderVisible = await visibleBranches(IDS.outsider);
  if (outsiderVisible.length !== 0) {
    throw new Error(`Unauthorized user can observe checkout operations: ${JSON.stringify(outsiderVisible)}`);
  }

  console.log("PASS: checkout operation RLS prevents cross-branch manager reads and preserves tenant-owner visibility.");
} finally {
  await db.close();
}
