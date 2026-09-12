-- P2 proactive operational alerts.
-- Deterministic, source-backed branch intelligence only; no business-state mutation authority.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_branch_operational_alerts_v1(
  p_branch_id uuid,
  p_as_of_date date DEFAULT current_date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_snapshot jsonb;
  v_tenant_id uuid;
  v_alerts jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF p_branch_id IS NULL OR p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'Branch and as-of date are required';
  END IF;

  -- Reuse the production reporting boundary for server-side tenant/branch authorization.
  -- The snapshot also establishes the authoritative tenant that owns the branch.
  v_snapshot := public.get_branch_reporting_snapshot_v1(
    p_branch_id,
    p_as_of_date::timestamptz,
    (p_as_of_date + 1)::timestamptz
  );
  v_tenant_id := (v_snapshot ->> 'tenant_id')::uuid;

  WITH branch_stock AS (
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      COALESCE(p.min_stock, 0)::numeric AS min_stock,
      COALESCE(SUM(s.quantity), 0)::numeric AS quantity
    FROM public.products p
    JOIN public.inventory_stocks s
      ON s.product_id = p.id
     AND s.tenant_id = v_tenant_id
     AND s.branch_id = p_branch_id
    WHERE p.tenant_id = v_tenant_id
      AND p.status = 'active'
    GROUP BY p.id, p.name, p.min_stock
  ),
  stock_alerts AS (
    SELECT
      CASE WHEN quantity <= 0 THEN 'out_of_stock' ELSE 'low_stock' END AS alert_type,
      CASE WHEN quantity <= 0 THEN 'critical' ELSE 'warning' END AS severity,
      product_id AS source_id,
      jsonb_build_object(
        'type', CASE WHEN quantity <= 0 THEN 'out_of_stock' ELSE 'low_stock' END,
        'severity', CASE WHEN quantity <= 0 THEN 'critical' ELSE 'warning' END,
        'branch_id', p_branch_id,
        'source_type', 'product',
        'source_id', product_id,
        'title', CASE
          WHEN quantity <= 0 THEN product_name || ' is out of stock'
          ELSE product_name || ' is below minimum stock'
        END,
        'evidence', jsonb_build_object(
          'product_id', product_id,
          'quantity', quantity,
          'min_stock', min_stock
        )
      ) AS alert
    FROM branch_stock
    WHERE quantity <= 0
       OR (min_stock > 0 AND quantity > 0 AND quantity < min_stock)
  ),
  lot_alerts AS (
    SELECT
      CASE WHEN l.expiry_date < p_as_of_date THEN 'expired_lot' ELSE 'expiring_lot' END AS alert_type,
      CASE WHEN l.expiry_date < p_as_of_date THEN 'critical' ELSE 'warning' END AS severity,
      l.id AS source_id,
      jsonb_build_object(
        'type', CASE WHEN l.expiry_date < p_as_of_date THEN 'expired_lot' ELSE 'expiring_lot' END,
        'severity', CASE WHEN l.expiry_date < p_as_of_date THEN 'critical' ELSE 'warning' END,
        'branch_id', p_branch_id,
        'source_type', 'inventory_lot',
        'source_id', l.id,
        'title', CASE
          WHEN l.expiry_date < p_as_of_date THEN p.name || ' has expired stock'
          ELSE p.name || ' has stock expiring within 30 days'
        END,
        'evidence', jsonb_build_object(
          'lot_id', l.id,
          'product_id', l.product_id,
          'batch_number', l.batch_number,
          'expiry_date', l.expiry_date,
          'quantity_remaining', l.quantity_remaining,
          'days_to_expiry', (l.expiry_date - p_as_of_date)
        )
      ) AS alert
    FROM public.inventory_lots l
    JOIN public.products p
      ON p.id = l.product_id
     AND p.tenant_id = l.tenant_id
    WHERE l.tenant_id = v_tenant_id
      AND l.branch_id = p_branch_id
      AND l.quantity_remaining > 0
      AND l.expiry_date IS NOT NULL
      AND l.expiry_date <= (p_as_of_date + 30)
  ),
  combined AS (
    SELECT alert_type, severity, source_id, alert FROM stock_alerts
    UNION ALL
    SELECT alert_type, severity, source_id, alert FROM lot_alerts
  )
  SELECT COALESCE(
    jsonb_agg(
      alert
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 ELSE 1 END,
        alert_type,
        source_id::text
    ),
    '[]'::jsonb
  )
  INTO v_alerts
  FROM combined;

  RETURN jsonb_build_object(
    'mode', 'read_only',
    'scope', jsonb_build_object(
      'tenant_id', v_tenant_id,
      'branch_id', p_branch_id,
      'as_of_date', p_as_of_date
    ),
    'evidence', jsonb_build_object(
      'source_type', 'postgresql_inventory_state',
      'authoritative', true,
      'currency', 'BHD',
      'money_unit', 'fils'
    ),
    'alerts', v_alerts,
    'limitations', jsonb_build_array(
      'Read-only operational intelligence only',
      'No business-state mutation authority',
      'Alerts are limited to persisted stock and expiry evidence for the selected branch',
      'Low-stock thresholds use the persisted product minimum-stock value',
      'Expiring-lot horizon is 30 calendar days'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_branch_operational_alerts_v1(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_branch_operational_alerts_v1(uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.get_branch_operational_alerts_v1(uuid, date) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_branch_operational_alerts_v1(uuid, date) TO authenticated;

COMMIT;
