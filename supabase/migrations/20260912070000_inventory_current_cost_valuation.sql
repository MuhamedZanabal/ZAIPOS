-- ZAIPOS P1 monetary inventory valuation.
--
-- This is deliberately CURRENT-COST valuation, not FIFO/WAC carrying cost.
-- public.inventory_stocks remains the physical quantity authority. public.product_prices
-- remains the exact-fils cost authority. Lot records do not yet carry immutable
-- acquisition-cost layers, so this read model must not imply FIFO/WAC precision.
--
-- Stock quantities have three-decimal precision. We therefore convert them to exact
-- integer milli-units, multiply by integer fils-per-unit to obtain exact millifils,
-- and only then round once to integer fils for the reportable BHD amount.

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
      selected_cost.amount_fils AS unit_cost_fils,
      CASE
        WHEN selected_cost.amount_fils IS NULL THEN 'missing_cost'
        WHEN selected_cost.branch_id IS NOT NULL THEN 'current_branch_cost'
        ELSE 'current_base_cost'
      END AS cost_source
    FROM scoped_stock ss
    LEFT JOIN LATERAL (
      SELECT pp.amount_fils, pp.branch_id
      FROM public.product_prices pp
      WHERE pp.tenant_id = _tenant_id
        AND pp.product_id = ss.product_id
        AND pp.price_type = 'cost'
        AND pp.effective_to IS NULL
        AND pp.channel IS NULL
        AND (pp.branch_id = _branch_id OR pp.branch_id IS NULL)
      ORDER BY
        (pp.branch_id = _branch_id) DESC NULLS LAST,
        pp.effective_from DESC,
        pp.id DESC
      LIMIT 1
    ) selected_cost ON true
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
  'Read-only current-cost inventory valuation. Uses authoritative aggregate stock, current branch cost with tenant/base fallback, exact milli-unit x fils arithmetic, and explicit missing-cost coverage. This is not FIFO/WAC carrying-cost valuation.';

CREATE OR REPLACE FUNCTION public.get_inventory_current_cost_valuation_summary_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _inventory_center_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH valuation AS (
    SELECT *
    FROM public.get_inventory_current_cost_valuation_v1(
      _tenant_id,
      _branch_id,
      _inventory_center_id
    )
  )
  SELECT jsonb_build_object(
    'tenant_id', _tenant_id,
    'branch_id', _branch_id,
    'inventory_center_id', _inventory_center_id,
    'valuation_method', 'current_cost',
    'total_value_millifils', COALESCE(sum(value_millifils), 0)::bigint,
    'total_value_fils', COALESCE(sum(value_fils), 0)::bigint,
    'valued_positions', count(*) FILTER (WHERE coverage_status = 'valued'),
    'missing_cost_positions', count(*) FILTER (WHERE coverage_status = 'missing_cost'),
    'coverage_status', CASE
      WHEN count(*) FILTER (WHERE coverage_status = 'missing_cost') = 0 THEN 'complete'
      ELSE 'incomplete'
    END
  )
  FROM valuation;
$$;

REVOKE ALL ON FUNCTION public.get_inventory_current_cost_valuation_summary_v1(uuid,uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_current_cost_valuation_summary_v1(uuid,uuid,uuid)
  TO authenticated;

COMMENT ON FUNCTION public.get_inventory_current_cost_valuation_summary_v1(uuid,uuid,uuid) IS
  'Summary for the current-cost valuation read model. Incomplete coverage is explicit when any non-zero stock position lacks current cost evidence.';

COMMIT;
