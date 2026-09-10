-- Harden product-financial commands so a branch-scoped manager cannot mutate
-- tenant-global prices/costs while preserving branch-local price authority and
-- purchase-receipt cost capture.

BEGIN;

CREATE OR REPLACE FUNCTION public.guard_product_financial_operation_scope_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
BEGIN
  IF _actor_id IS NOT NULL
    AND NEW.operation_kind = 'base_financials'
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_roles role_row
      WHERE role_row.user_id = _actor_id
        AND role_row.tenant_id = NEW.tenant_id
        AND role_row.branch_id IS NULL
        AND role_row.role = ANY(ARRAY['owner','admin','manager']::public.app_role[])
    )
  THEN
    RAISE EXCEPTION 'Tenant-wide product financial change is forbidden for this role scope';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.guard_product_financial_operation_scope_v1()
FROM PUBLIC, anon, authenticated;

CREATE TRIGGER product_financial_operations_scope_guard
BEFORE INSERT ON public.product_financial_operations
FOR EACH ROW EXECUTE FUNCTION public.guard_product_financial_operation_scope_v1();

CREATE OR REPLACE FUNCTION public.guard_product_financial_direct_write_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _command_active boolean := COALESCE(current_setting('zaipos.product_financial_command', true), '') = 'on';
  _selling_changed boolean := NEW.price IS DISTINCT FROM OLD.price
    OR NEW.price_fils IS DISTINCT FROM OLD.price_fils;
  _financial_changed boolean := _selling_changed
    OR NEW.cost IS DISTINCT FROM OLD.cost
    OR NEW.cost_fils IS DISTINCT FROM OLD.cost_fils;
BEGIN
  IF _actor_id IS NOT NULL AND _financial_changed AND NOT _command_active THEN
    RAISE EXCEPTION 'Product financial changes must use an authoritative financial command';
  END IF;

  -- A tenant-global base selling price affects every branch. Even when the
  -- authoritative command has enabled the guarded write path, only a role that
  -- is explicitly tenant-wide (branch_id IS NULL) may change that selling price.
  -- Purchase receiving changes cost only, so branch-scoped inventory receiving
  -- remains valid and continues to capture branch-specific received-cost history.
  IF _actor_id IS NOT NULL
    AND _command_active
    AND _selling_changed
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_roles role_row
      WHERE role_row.user_id = _actor_id
        AND role_row.tenant_id = NEW.tenant_id
        AND role_row.branch_id IS NULL
        AND role_row.role = ANY(ARRAY['owner','admin','manager']::public.app_role[])
    )
  THEN
    RAISE EXCEPTION 'Tenant-wide selling-price change is forbidden for this role scope';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.guard_product_financial_direct_write_v1()
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_context_price_direct_write_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _tenant_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  _branch_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.branch_id ELSE NEW.branch_id END;
  _command_active boolean := COALESCE(current_setting('zaipos.product_financial_command', true), '') = 'on';
BEGIN
  IF _actor_id IS NOT NULL AND NOT _command_active THEN
    RAISE EXCEPTION 'Context selling-price changes must use an authoritative price command';
  END IF;

  -- NULL branch means the price is tenant-global for the selected channel.
  -- A manager assigned to one branch must not be able to alter that value.
  IF _actor_id IS NOT NULL
    AND _command_active
    AND _branch_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_roles role_row
      WHERE role_row.user_id = _actor_id
        AND role_row.tenant_id = _tenant_id
        AND role_row.branch_id IS NULL
        AND role_row.role = ANY(ARRAY['owner','admin','manager']::public.app_role[])
    )
  THEN
    RAISE EXCEPTION 'Tenant-wide channel-price change is forbidden for this role scope';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.guard_context_price_direct_write_v1()
FROM PUBLIC, anon, authenticated;

COMMIT;
