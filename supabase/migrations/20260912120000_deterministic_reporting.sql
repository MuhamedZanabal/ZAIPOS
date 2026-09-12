-- Authoritative deterministic branch reporting built exclusively from persisted data.
-- Financial truth is aggregated as integer fils; the client only formats results.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_branch_reporting_snapshot_v1(
  _branch_id uuid,
  _start_at timestamptz,
  _end_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _tenant_id uuid;
  _sales_count bigint := 0;
  _total_sales_fils bigint := 0;
  _trend jsonb := '[]'::jsonb;
  _channels jsonb := '[]'::jsonb;
  _payments jsonb := '[]'::jsonb;
  _top_products jsonb := '[]'::jsonb;
  _recent_sales jsonb := '[]'::jsonb;
  _inventory jsonb := '{}'::jsonb;
  _cash jsonb := '{}'::jsonb;
  _production_units numeric := 0;
  _active_channels jsonb := '[]'::jsonb;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF _branch_id IS NULL OR _start_at IS NULL OR _end_at IS NULL OR _end_at <= _start_at THEN
    RAISE EXCEPTION 'Invalid reporting range';
  END IF;

  IF _end_at - _start_at > interval '366 days' THEN
    RAISE EXCEPTION 'Reporting range exceeds 366 days';
  END IF;

  SELECT b.tenant_id
    INTO _tenant_id
    FROM public.branches b
   WHERE b.id = _branch_id
     AND b.status = 'active';

  IF _tenant_id IS NULL THEN
    RAISE EXCEPTION 'Branch not found or inactive';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.user_roles ur
     WHERE ur.user_id = _user_id
       AND ur.tenant_id = _tenant_id
       AND (ur.branch_id IS NULL OR ur.branch_id = _branch_id)
  ) THEN
    RAISE EXCEPTION 'Forbidden: branch access required' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::bigint, COALESCE(sum(s.total_fils), 0)::bigint
    INTO _sales_count, _total_sales_fils
    FROM public.sales s
   WHERE s.tenant_id = _tenant_id
     AND s.branch_id = _branch_id
     AND s.status = 'completed'
     AND s.created_at >= _start_at
     AND s.created_at < _end_at;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'bucket_start', q.bucket_start,
           'sales_count', q.sales_count,
           'total_fils', q.total_fils
         ) ORDER BY q.bucket_start), '[]'::jsonb)
    INTO _trend
    FROM (
      SELECT date_trunc('day', s.created_at) AS bucket_start,
             count(*)::bigint AS sales_count,
             COALESCE(sum(s.total_fils), 0)::bigint AS total_fils
        FROM public.sales s
       WHERE s.tenant_id = _tenant_id
         AND s.branch_id = _branch_id
         AND s.status = 'completed'
         AND s.created_at >= _start_at
         AND s.created_at < _end_at
       GROUP BY 1
    ) q;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'channel', q.channel,
           'sales_count', q.sales_count,
           'amount_fils', q.amount_fils
         ) ORDER BY q.amount_fils DESC, q.channel), '[]'::jsonb)
    INTO _channels
    FROM (
      SELECT s.channel::text AS channel,
             count(*)::bigint AS sales_count,
             COALESCE(sum(s.total_fils), 0)::bigint AS amount_fils
        FROM public.sales s
       WHERE s.tenant_id = _tenant_id
         AND s.branch_id = _branch_id
         AND s.status = 'completed'
         AND s.created_at >= _start_at
         AND s.created_at < _end_at
       GROUP BY s.channel
    ) q;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'method', q.method,
           'amount_fils', q.amount_fils
         ) ORDER BY q.amount_fils DESC, q.method), '[]'::jsonb)
    INTO _payments
    FROM (
      SELECT p.method::text AS method,
             COALESCE(sum(p.amount_fils), 0)::bigint AS amount_fils
        FROM public.payments p
        JOIN public.sales s ON s.id = p.sale_id
       WHERE s.tenant_id = _tenant_id
         AND s.branch_id = _branch_id
         AND s.status = 'completed'
         AND s.created_at >= _start_at
         AND s.created_at < _end_at
       GROUP BY p.method
    ) q;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', q.product_id,
           'name', q.product_name,
           'category', q.category_name,
           'quantity', q.quantity,
           'amount_fils', q.amount_fils
         ) ORDER BY q.quantity DESC, q.amount_fils DESC, q.product_name), '[]'::jsonb)
    INTO _top_products
    FROM (
      SELECT si.product_id,
             min(si.product_name) AS product_name,
             COALESCE(min(c.name), 'Uncategorized') AS category_name,
             sum(si.quantity) AS quantity,
             COALESCE(sum(si.line_total_fils), 0)::bigint AS amount_fils
        FROM public.sale_items si
        JOIN public.sales s ON s.id = si.sale_id
        LEFT JOIN public.products p ON p.id = si.product_id AND p.tenant_id = _tenant_id
        LEFT JOIN public.categories c ON c.id = p.category_id AND c.tenant_id = _tenant_id
       WHERE s.tenant_id = _tenant_id
         AND s.branch_id = _branch_id
         AND s.status = 'completed'
         AND s.created_at >= _start_at
         AND s.created_at < _end_at
       GROUP BY si.product_id
       ORDER BY sum(si.quantity) DESC, COALESCE(sum(si.line_total_fils), 0) DESC
       LIMIT 5
    ) q;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', q.id,
           'ticket_number', q.ticket_number,
           'total_fils', q.total_fils,
           'created_at', q.created_at,
           'channel', q.channel
         ) ORDER BY q.created_at DESC, q.id), '[]'::jsonb)
    INTO _recent_sales
    FROM (
      SELECT s.id, s.ticket_number, s.total_fils, s.created_at, s.channel::text AS channel
        FROM public.sales s
       WHERE s.tenant_id = _tenant_id
         AND s.branch_id = _branch_id
         AND s.status = 'completed'
         AND s.created_at >= _start_at
         AND s.created_at < _end_at
       ORDER BY s.created_at DESC, s.id
       LIMIT 5
    ) q;

  SELECT jsonb_build_object(
           'total_skus', count(*)::bigint,
           'low_stock_count', count(*) FILTER (
             WHERE st.quantity <= COALESCE(p.min_stock, 0) AND st.quantity > 0
           )::bigint,
           'out_of_stock_count', count(*) FILTER (WHERE st.quantity <= 0)::bigint
         )
    INTO _inventory
    FROM public.inventory_stocks st
    JOIN public.products p
      ON p.id = st.product_id
     AND p.tenant_id = _tenant_id
     AND p.status = 'active'
   WHERE st.tenant_id = _tenant_id
     AND st.branch_id = _branch_id;

  SELECT COALESCE(jsonb_build_object(
           'open', true,
           'expected_fils', cs.opening_amount_fils + cs.total_cash_fils + cs.total_in_fils - cs.total_out_fils
         ), jsonb_build_object('open', false, 'expected_fils', 0))
    INTO _cash
    FROM public.cash_sessions cs
   WHERE cs.tenant_id = _tenant_id
     AND cs.branch_id = _branch_id
     AND cs.status = 'open'
   ORDER BY cs.opened_at DESC
   LIMIT 1;

  IF _cash IS NULL THEN
    _cash := jsonb_build_object('open', false, 'expected_fils', 0);
  END IF;

  SELECT COALESCE(sum(po.produced_quantity), 0)
    INTO _production_units
    FROM public.production_orders po
   WHERE po.tenant_id = _tenant_id
     AND po.branch_id = _branch_id
     AND po.created_at >= _start_at
     AND po.created_at < _end_at;

  SELECT COALESCE(to_jsonb(t.active_channels), '[]'::jsonb)
    INTO _active_channels
    FROM public.tenants t
   WHERE t.id = _tenant_id;

  RETURN jsonb_build_object(
    'branch_id', _branch_id,
    'tenant_id', _tenant_id,
    'start_at', _start_at,
    'end_at', _end_at,
    'sales_count', _sales_count,
    'total_sales_fils', _total_sales_fils,
    'average_ticket_fils', CASE WHEN _sales_count = 0 THEN 0 ELSE (_total_sales_fils / _sales_count)::bigint END,
    'trend', _trend,
    'channels', _channels,
    'payments', _payments,
    'top_products', _top_products,
    'recent_sales', _recent_sales,
    'inventory', _inventory,
    'cash', _cash,
    'production_units', _production_units,
    'active_channels', _active_channels
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_branch_reporting_snapshot_v1(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_branch_reporting_snapshot_v1(uuid, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_branch_reporting_snapshot_v1(uuid, timestamptz, timestamptz) TO service_role;

COMMIT;
