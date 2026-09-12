-- ZAIPOS P1 stocktake hardening: enforce tenant/branch structural integrity.
--
-- stocktakes carries both tenant_id and branch_id. The branch relationship must be
-- composite so a branch from another tenant cannot be paired with the stocktake
-- tenant even if both UUIDs are individually valid.

BEGIN;

ALTER TABLE public.stocktakes
  ADD CONSTRAINT stocktakes_tenant_branch_fkey
  FOREIGN KEY (tenant_id, branch_id)
  REFERENCES public.branches(tenant_id, id)
  ON DELETE RESTRICT;

COMMIT;
