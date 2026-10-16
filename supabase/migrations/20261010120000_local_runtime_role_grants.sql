-- Local runtime role grants.
--
-- Table and function privileges for anon/authenticated/service_role come from
-- the Supabase-equivalent default privileges that the local service sets up
-- before the first migration (local-service/src/provisioning/postgres.rs), so
-- every earlier revocation keeps its meaning. What a plain PostgreSQL still lacks
-- is schema access for auth.uid()/auth.role() used by RLS policies and
-- SECURITY DEFINER functions, and the local service's own access to the local
-- identity tables. On a fresh install, first-owner setup failed with
-- "permission denied for table zaipos_local_users".
DO $$
BEGIN
  -- Local runtime only: zaipos_service exists only in clusters provisioned by
  -- the local service. Hosted Supabase already has these grants and its auth
  -- schema belongs to supabase_auth_admin, so nothing here runs there.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zaipos_service')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
    -- Local credentials, sessions, and the outbox are never reachable through the API roles.
    REVOKE ALL ON public.zaipos_local_users, public.zaipos_local_devices,
      public.zaipos_local_sessions, public.zaipos_outbox
      FROM PUBLIC, anon, authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zaipos_service') THEN
    -- The local service authenticates users and records its terminals itself.
    GRANT USAGE ON SCHEMA public, auth TO zaipos_service;
    GRANT SELECT, INSERT, UPDATE ON public.zaipos_local_users,
      public.zaipos_local_devices, public.zaipos_local_sessions TO zaipos_service;
    GRANT SELECT, INSERT ON public.zaipos_outbox TO zaipos_service;
    GRANT SELECT ON public.zaipos_daily_sales TO zaipos_service;
    GRANT SELECT, INSERT ON auth.users TO zaipos_service;
  END IF;
END
$$;

-- The receipt snapshot guard allowed only Supabase's superuser role names to
-- write the snapshot. The SECURITY DEFINER capture trigger runs as the schema
-- owner, which is `postgres` on Supabase but the bootstrap owner locally, so
-- every local sale failed at commit. Allow the role that owns the capture
-- function, which is the same check on Supabase.
CREATE OR REPLACE FUNCTION public.prevent_sale_receipt_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.receipt_snapshot IS DISTINCT FROM NEW.receipt_snapshot
     AND current_user NOT IN ('postgres', 'supabase_admin', 'service_role')
     AND current_user <> (
       SELECT pg_catalog.pg_get_userbyid(p.proowner)
       FROM pg_catalog.pg_proc p
       WHERE p.oid = 'public.capture_sale_receipt_snapshot()'::pg_catalog.regprocedure
     ) THEN
    RAISE EXCEPTION 'Historical receipt snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_sale_receipt_snapshot_mutation()
  FROM PUBLIC, anon, authenticated;
