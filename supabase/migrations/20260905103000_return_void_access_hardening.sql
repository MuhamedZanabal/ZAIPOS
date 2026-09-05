-- ZAIPOS P0.6: return/void evidence access hardening.
--
-- Compensating ledgers are command-owned. Authenticated managers may read only
-- evidence for branches they are authorized to manage; no authenticated client
-- may insert, update, delete, truncate, reference, or trigger these tables
-- directly.

BEGIN;

ALTER TABLE public.sale_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_void_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_voids ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sale_returns_branch_select_v2 ON public.sale_returns;
CREATE POLICY sale_returns_branch_select_v2
ON public.sale_returns
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

DROP POLICY IF EXISTS sale_return_items_branch_select_v2 ON public.sale_return_items;
CREATE POLICY sale_return_items_branch_select_v2
ON public.sale_return_items
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

DROP POLICY IF EXISTS payment_refunds_branch_select_v2 ON public.payment_refunds;
CREATE POLICY payment_refunds_branch_select_v2
ON public.payment_refunds
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

DROP POLICY IF EXISTS sale_voids_branch_select_v2 ON public.sale_voids;
CREATE POLICY sale_voids_branch_select_v2
ON public.sale_voids
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

DROP POLICY IF EXISTS sale_void_items_branch_select_v2 ON public.sale_void_items;
CREATE POLICY sale_void_items_branch_select_v2
ON public.sale_void_items
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

DROP POLICY IF EXISTS payment_voids_branch_select_v2 ON public.payment_voids;
CREATE POLICY payment_voids_branch_select_v2
ON public.payment_voids
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

REVOKE ALL ON public.sale_returns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sale_return_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payment_refunds FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sale_voids FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sale_void_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payment_voids FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.sale_returns TO authenticated;
GRANT SELECT ON public.sale_return_items TO authenticated;
GRANT SELECT ON public.payment_refunds TO authenticated;
GRANT SELECT ON public.sale_voids TO authenticated;
GRANT SELECT ON public.sale_void_items TO authenticated;
GRANT SELECT ON public.payment_voids TO authenticated;

COMMIT;
