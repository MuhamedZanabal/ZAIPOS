-- Preserve the repository-wide tenant/branch structural invariant for the
-- inventory lot tables introduced by 20260912040000_inventory_lots_expiry.sql.
BEGIN;

ALTER TABLE public.product_inventory_controls
  ADD CONSTRAINT product_inventory_controls_tenant_branch_fkey
  FOREIGN KEY (tenant_id, branch_id)
  REFERENCES public.branches(tenant_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE public.inventory_lots
  ADD CONSTRAINT inventory_lots_tenant_branch_fkey
  FOREIGN KEY (tenant_id, branch_id)
  REFERENCES public.branches(tenant_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE public.inventory_lot_movements
  ADD CONSTRAINT inventory_lot_movements_tenant_branch_fkey
  FOREIGN KEY (tenant_id, branch_id)
  REFERENCES public.branches(tenant_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

COMMIT;
