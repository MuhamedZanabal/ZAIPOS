-- Fix current-cost inventory valuation branch/base precedence.
--
-- The initial valuation read model selected branch and tenant/base costs from one mixed
-- candidate set. The runtime contract demonstrated that a current branch cost could be
-- bypassed in favour of the base cost. Keep the price ledger authoritative and make the
-- precedence structural: resolve the current branch cost and current base cost
-- independently, then use the branch cost whenever it exists.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_inventory_current_cost_valuation_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _inventory_center_id uuid DEFAULT NULL
)
RETURNS TABLE(
  inventory_center_id uuid,
  product_id uuid,
  quantity numeric,
  quantity_milliunits bigint,
  unit_cost_fils bigint,
  cost_source text,
  value_millifils bigint,
  value_fils bigint,
  coverage_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _user_id uuid := auth.uid();
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.has_branch_role(
    _user_id,
    _tenant_id,
    _branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.branches b
    WHERE b.id = _branch_id
      AND b.tenant_id = _tenant_id
  ) THEN
    RAISE EXCEPTION 'Branch does not belong to tenant';
  END IF;

  IF _inventory_center_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.inventory_centers c
    WHERE c.id = _inventory_center_id
      AND c.tenant_id = _tenant_id
      AND c.branch_id = _branch_id
  ) THEN
    RAISE EXCEPTION 'Inventory center does not belong to tenant and branch';
  END IF;

  RETURN QUERY
  WITH scoped_stock AS (
    SELECT
      s.inventory_center_id,
      s.product_id,
      s.quantity,
      round(s.quantity * 1000)::bigint AS quantity_milliunits
    FROM public.inventory_stocks s
    WHERE s.tenant_id = _tenant_id
      AND s.branch_id = _branch_id
      AND (_inventory_center_id IS NULL OR s.inventory_center_id = _inventory_center_id)
      AND s.quantity <> 0
  ),
  costed AS (
    SELECT
      ss.inventory_center_id,
      ss.product_id,
      ss.quantity,
      ss.quantity_milliunits,
      COALESCE(branch_cost.amount_fils, base_cost.amount_fils) AS unit_cost_fils,
      CASE
        WHEN branch_cost.amount_fils IS NOT NULL THEN 'current_branch_cost'
        WHEN base_cost.amount_fils IS NOT NULL THEN 'current_base_cost'
        ELSE 'missing_cost'
      END AS cost_source
    FROM scoped_stock ss
    LEFT JOIN LATERAL (
      SELECT pp.amount_fils
      FROM public.product_prices pp
      WHERE pp.tenant_id = _tenant_id
        AND pp.product_id = ss.product_id
        AND pp.price_type = 'cost'
        AND pp.effective_to IS NULL
        AND pp.channel IS NULL
        AND pp.branch_id = _branch_id
      ORDER BY pp.effective_from DESC, pp.id DESC
      LIMIT 1
    ) branch_cost ON true
    LEFT JOIN LATERAL (
      SELECT pp.amount_fils
      FROM public.product_prices pp
      WHERE pp.tenant_id = _tenant_id
        AND pp.product_id = ss.product_id
        AND pp.price_type = 'cost'
        AND pp.effective_to IS NULL
        AND pp.channel IS NULL
        AND pp.branch_id IS NULL
      ORDER BY pp.effective_from DESC, pp.id DESC
      LIMIT 1
    ) base_cost ON true
  )
  SELECT
    c.inventory_center_id,
    c.product_id,
    c.quantity,
    c.quantity_milliunits,
    c.unit_cost_fils,
    c.cost_source,
    CASE
      WHEN c.unit_cost_fils IS NULL THEN NULL
      ELSE c.quantity_milliunits * c.unit_cost_fils
    END AS value_millifils,
    CASE
      WHEN c.unit_cost_fils IS NULL THEN NULL
      ELSE round((c.quantity_milliunits * c.unit_cost_fils)::numeric / 1000)::bigint
    END AS value_fils,
    CASE WHEN c.unit_cost_fils IS NULL THEN 'missing_cost' ELSE 'valued' END AS coverage_status
  FROM costed c
  ORDER BY c.inventory_center_id, c.product_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_inventory_current_cost_valuation_v1(uuid,uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_current_cost_valuation_v1(uuid,uuid,uuid)
  TO authenticated;

COMMENT ON FUNCTION public.get_inventory_current_cost_valuation_v1(uuid,uuid,uuid) IS
  'Read-only current-cost inventory valuation. Uses authoritative aggregate stock, structurally prefers current branch cost over tenant/base fallback, preserves exact milli-unit x fils arithmetic, and exposes missing-cost coverage. This is not FIFO/WAC carrying-cost valuation.';

COMMIT;
