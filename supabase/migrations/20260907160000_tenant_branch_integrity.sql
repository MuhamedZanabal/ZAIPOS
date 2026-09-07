-- P0 tenant/branch structural integrity.
--
-- A standalone branch_id FK proves that a branch exists, but it does not prove
-- that the row's tenant_id owns that branch. Every current public table that
-- carries both columns receives a composite FK to the canonical branch key.
-- Nullable branch scopes (for example tenant-wide user roles) intentionally
-- remain valid through the default MATCH SIMPLE behavior.

BEGIN;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.branches'::regclass
      AND conname = 'branches_tenant_id_id_key'
  ) THEN
    ALTER TABLE public.branches
      ADD CONSTRAINT branches_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END
$migration$;

DO $migration$
DECLARE
  scoped_table record;
  constraint_name text;
BEGIN
  FOR scoped_table IN
    SELECT candidate.relname
    FROM pg_class candidate
    JOIN pg_namespace namespace ON namespace.oid = candidate.relnamespace
    WHERE namespace.nspname = 'public'
      AND candidate.relkind IN ('r', 'p')
      AND EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        WHERE attribute.attrelid = candidate.oid
          AND attribute.attname = 'tenant_id'
          AND NOT attribute.attisdropped
      )
      AND EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        WHERE attribute.attrelid = candidate.oid
          AND attribute.attname = 'branch_id'
          AND NOT attribute.attisdropped
      )
    ORDER BY candidate.relname
  LOOP
    constraint_name := left(scoped_table.relname, 43) || '_tenant_branch_fkey';

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = format('public.%I', scoped_table.relname)::regclass
        AND conname = constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, branch_id) REFERENCES public.branches(tenant_id, id) NOT VALID',
        scoped_table.relname,
        constraint_name
      );
    END IF;
  END LOOP;
END
$migration$;

DO $migration$
DECLARE
  scoped_table record;
  constraint_name text;
BEGIN
  FOR scoped_table IN
    SELECT candidate.relname
    FROM pg_class candidate
    JOIN pg_namespace namespace ON namespace.oid = candidate.relnamespace
    WHERE namespace.nspname = 'public'
      AND candidate.relkind IN ('r', 'p')
      AND EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        WHERE attribute.attrelid = candidate.oid
          AND attribute.attname = 'tenant_id'
          AND NOT attribute.attisdropped
      )
      AND EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        WHERE attribute.attrelid = candidate.oid
          AND attribute.attname = 'branch_id'
          AND NOT attribute.attisdropped
      )
    ORDER BY candidate.relname
  LOOP
    constraint_name := left(scoped_table.relname, 43) || '_tenant_branch_fkey';
    EXECUTE format(
      'ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
      scoped_table.relname,
      constraint_name
    );
  END LOOP;
END
$migration$;

COMMIT;
