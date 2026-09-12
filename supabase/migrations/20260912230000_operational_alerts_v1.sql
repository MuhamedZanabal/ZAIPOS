-- P2 deterministic operational alerts v1.
-- Extends the source-backed alert boundary with explicit expiry/cash windows and exact-fils cash variance.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_operational_alerts_v1(
  _branch_id uuid,
  _as_of timestamptz,
  _expiry_horizon_days integer,
  _cash_lookback_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _tenant_id uuid;
  _as_of_date date;
  _alerts jsonb := '[]'::jsonb;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF _branch_id IS NULL OR _as_of IS NULL THEN
    RAISE EXCEPTION 'Branch and as-of timestamp are required';
  END IF;

  IF _expiry_horizon_days IS NULL OR _expiry_horizon_days < 0 OR _expiry_horizon_days > 365 THEN
    RAISE EXCEPTION 'Expiry horizon must be between 0 and 365 days';
  END IF;

  IF _cash_lookback_days IS NULL OR _cash_lookback_days < 0 OR _cash_lookback_days > 365 THEN
    RAISE EXCEPTION 'Cash lookback must be between 0 and 365 days';
  END IF;

  SELECT b.tenant_id
    INTO _tenant_id
    FROM public.branches b
   WHERE b.id = _branch_id
     AND b.status = 'active';

  IF _tenant_id IS NULL THEN
    RAISE EXCEPTION 'Branch not found or inactive' USING ERRCODE = '42501';
  END IF;

  -- Mirror the deterministic reporting authorization boundary: any persisted role for
  -- the tenant that is tenant-wide or scoped to this branch may read branch intelligence.
  IF NOT EXISTS (
    SELECT 1
      FROM public.user_roles ur
     WHERE ur.user_id = _user_id
       AND ur.tenant_id = _tenant_id
       AND (ur.branch_id IS NULL OR ur.branch_id = _branch_id)
  ) THEN
    RAISE EXCEPTION 'Forbidden: branch access required' USING ERRCODE = '42501';
  END IF;

  _as_of_date := (_as_of AT TIME ZONE 'Asia/Bahrain')::date;

  WITH branch_stock AS (
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      COALESCE(p.min_stock, 0)::numeric AS min_stock,
      COALESCE(SUM(s.quantity), 0)::numeric AS quantity
    FROM public.products p
    JOIN public.inventory_stocks s
      ON s.product_id = p.id
     AND s.tenant_id = _tenant_id
     AND s.branch_id = _branch_id
    WHERE p.tenant_id = _tenant_id
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
        'branch_id', _branch_id,
        'source_type', 'product',
        'source_id', product_id,
        'title', CASE
          WHEN quantity <= 0 THEN product_name || ' is out of stock'
          ELSE product_name || ' is at or below minimum stock'
        END,
        'evidence', jsonb_build_object(
          'product_id', product_id,
          'quantity', quantity,
          'min_stock', min_stock
        )
      ) AS alert
    FROM branch_stock
    WHERE quantity <= 0
       OR (min_stock > 0 AND quantity > 0 AND quantity <= min_stock)
  ),
  lot_alerts AS (
    SELECT
      CASE WHEN l.expiry_date < _as_of_date THEN 'expired_lot_stock' ELSE 'expiry_due' END AS alert_type,
      CASE WHEN l.expiry_date < _as_of_date THEN 'critical' ELSE 'warning' END AS severity,
      l.id AS source_id,
      jsonb_build_object(
        'type', CASE WHEN l.expiry_date < _as_of_date THEN 'expired_lot_stock' ELSE 'expiry_due' END,
        'severity', CASE WHEN l.expiry_date < _as_of_date THEN 'critical' ELSE 'warning' END,
        'branch_id', _branch_id,
        'source_type', 'inventory_lot',
        'source_id', l.id,
        'title', CASE
          WHEN l.expiry_date < _as_of_date THEN p.name || ' has expired stock'
          ELSE p.name || ' has stock due to expire within the selected horizon'
        END,
        'evidence', jsonb_build_object(
          'lot_id', l.id,
          'product_id', l.product_id,
          'batch_number', l.batch_number,
          'expiry_date', l.expiry_date,
          'quantity_remaining', l.quantity_remaining,
          'days_to_expiry', (l.expiry_date - _as_of_date),
          'expiry_horizon_days', _expiry_horizon_days
        )
      ) AS alert
    FROM public.inventory_lots l
    JOIN public.products p
      ON p.id = l.product_id
     AND p.tenant_id = l.tenant_id
    WHERE l.tenant_id = _tenant_id
      AND l.branch_id = _branch_id
      AND l.quantity_remaining > 0
      AND l.expiry_date IS NOT NULL
      AND l.expiry_date <= (_as_of_date + _expiry_horizon_days)
  ),
  cash_alerts AS (
    SELECT
      'cash_variance'::text AS alert_type,
      'warning'::text AS severity,
      cs.id AS source_id,
      jsonb_build_object(
        'type', 'cash_variance',
        'severity', 'warning',
        'branch_id', _branch_id,
        'source_type', 'cash_session',
        'source_id', cs.id,
        'title', 'Closed register session has a cash variance',
        'evidence', jsonb_build_object(
          'cash_session_id', cs.id,
          'closed_at', cs.closed_at,
          'difference_fils', cs.difference_fils,
          'absolute_difference_fils', abs(cs.difference_fils),
          'cash_lookback_days', _cash_lookback_days,
          'currency', 'BHD',
          'money_unit', 'fils'
        )
      ) AS alert
    FROM public.cash_sessions cs
    WHERE cs.tenant_id = _tenant_id
      AND cs.branch_id = _branch_id
      AND cs.status = 'closed'
      AND cs.closed_at IS NOT NULL
      AND cs.closed_at <= _as_of
      AND cs.closed_at >= (_as_of - make_interval(days => _cash_lookback_days))
      AND cs.difference_fils IS NOT NULL
      AND cs.difference_fils <> 0
  ),
  combined AS (
    SELECT alert_type, severity, source_id, alert FROM stock_alerts
    UNION ALL
    SELECT alert_type, severity, source_id, alert FROM lot_alerts
    UNION ALL
    SELECT alert_type, severity, source_id, alert FROM cash_alerts
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
  INTO _alerts
  FROM combined;

  RETURN jsonb_build_object(
    'mode', 'read_only',
    'scope', jsonb_build_object(
      'tenant_id', _tenant_id,
      'branch_id', _branch_id,
      'as_of', _as_of,
      'as_of_date_bahrain', _as_of_date,
      'expiry_horizon_days', _expiry_horizon_days,
      'cash_lookback_days', _cash_lookback_days
    ),
    'evidence', jsonb_build_object(
      'source_type', 'postgresql_operational_state',
      'authoritative', true,
      'currency', 'BHD',
      'money_unit', 'fils'
    ),
    'alerts', _alerts,
    'limitations', jsonb_build_array(
      'Read-only operational intelligence only',
      'No business-state mutation authority',
      'Inventory alerts require persisted branch inventory rows',
      'Low-stock thresholds use persisted product minimum-stock values',
      'Expiry horizon and closed-session cash lookback are explicit caller inputs bounded to 0..365 days',
      'Cash variance evidence uses immutable integer-fils close evidence only'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_operational_alerts_v1(uuid, timestamptz, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_operational_alerts_v1(uuid, timestamptz, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_operational_alerts_v1(uuid, timestamptz, integer, integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_operational_alerts_v1(uuid, timestamptz, integer, integer) TO authenticated;

COMMIT;
