-- P0 authorization hardening: role helpers must reject banned/deleted accounts.
-- This preserves existing tenant/branch role semantics while making account
-- state part of every RLS/RPC boundary that relies on these canonical helpers.
BEGIN;

CREATE OR REPLACE FUNCTION public.is_active_auth_user(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE u.id = _user_id
      AND u.deleted_at IS NULL
      AND (u.banned_until IS NULL OR u.banned_until <= now())
  );
$function$;

REVOKE ALL ON FUNCTION public.is_active_auth_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_active_auth_user(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _tenant_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.is_active_auth_user(_user_id) AND EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND (
        ur.role = 'super_admin'::public.app_role
        OR (ur.tenant_id = _tenant_id AND ur.role = _role)
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.has_any_role(_user_id uuid, _tenant_id uuid, _roles public.app_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.is_active_auth_user(_user_id) AND EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND (
        ur.role = 'super_admin'::public.app_role
        OR (ur.tenant_id = _tenant_id AND ur.role = ANY(_roles))
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_tenant_member(_user_id uuid, _tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.is_active_auth_user(_user_id) AND EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND (ur.role = 'super_admin'::public.app_role OR ur.tenant_id = _tenant_id)
  );
$function$;

CREATE OR REPLACE FUNCTION public.has_branch_role(
  _user_id uuid,
  _tenant_id uuid,
  _branch_id uuid,
  _roles public.app_role[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.is_active_auth_user(_user_id)
    AND NOT EXISTS (
      SELECT 1
      FROM public.employees e
      WHERE e.user_id = _user_id
        AND e.tenant_id = _tenant_id
        AND (e.branch_id IS NULL OR e.branch_id = _branch_id)
        AND e.status::text = 'inactive'
    )
    AND EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = _user_id
        AND (
          ur.role = 'super_admin'::public.app_role
          OR (
            ur.tenant_id = _tenant_id
            AND ur.role = ANY(_roles)
            AND (ur.branch_id IS NULL OR ur.branch_id = _branch_id)
          )
        )
    );
$function$;

REVOKE ALL ON FUNCTION public.has_role(uuid,uuid,public.app_role) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_any_role(uuid,uuid,public.app_role[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_tenant_member(uuid,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_branch_role(uuid,uuid,uuid,public.app_role[]) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.has_role(uuid,uuid,public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_any_role(uuid,uuid,public.app_role[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_tenant_member(uuid,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_branch_role(uuid,uuid,uuid,public.app_role[]) TO authenticated, service_role;

-- Return-evidence storage originally read user_roles directly, bypassing the
-- active-account gate above. Keep the tenant-folder model but route it through
-- the canonical membership helper.
DROP POLICY IF EXISTS "return_evidence_tenant_select" ON storage.objects;
CREATE POLICY "return_evidence_tenant_select"
ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'return-evidence'
  AND public.is_tenant_member(auth.uid(), (storage.foldername(name))[1]::uuid)
);

DROP POLICY IF EXISTS "return_evidence_tenant_insert" ON storage.objects;
CREATE POLICY "return_evidence_tenant_insert"
ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'return-evidence'
  AND public.is_tenant_member(auth.uid(), (storage.foldername(name))[1]::uuid)
);

COMMIT;
