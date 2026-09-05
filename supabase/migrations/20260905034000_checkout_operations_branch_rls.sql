-- ZAIPOS P0.3 security hardening.
-- checkout_operations contains request payload/evidence for a branch-scoped
-- financial command. A manager assigned to one branch must not gain tenant-wide
-- visibility merely because they hold the manager role somewhere in the tenant.

BEGIN;

DROP POLICY IF EXISTS checkout_operations_admin_select ON public.checkout_operations;
CREATE POLICY checkout_operations_admin_select
ON public.checkout_operations
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(),
    tenant_id,
    branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

COMMENT ON POLICY checkout_operations_admin_select ON public.checkout_operations IS
  'Owner/admin/manager checkout-operation visibility follows the same tenant + branch role scope as financial commands.';

COMMIT;
