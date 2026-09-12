-- P1 authoritative cash/till intelligence.
-- Read-only reporting over immutable exact-fils close evidence. No client-side
-- balance reconstruction and no legacy decimal money columns are authoritative.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_cash_till_intelligence_v1(
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
  _sessions jsonb := '[]'::jsonb;
  _closed_session_count bigint := 0;
  _expected_amount_fils bigint := 0;
  _counted_cash_fils bigint := 0;
  _difference_fils bigint := 0;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF _branch_id IS NULL OR _start_at IS NULL OR _end_at IS NULL OR _end_at <= _start_at THEN
    RAISE EXCEPTION 'Invalid cash/till reporting range';
  END IF;

  IF _end_at - _start_at > interval '366 days' THEN
    RAISE EXCEPTION 'Cash/till reporting range exceeds 366 days';
  END IF;

  SELECT b.tenant_id
    INTO _tenant_id
    FROM public.branches b
   WHERE b.id = _branch_id
     AND b.status = 'active';

  IF _tenant_id IS NULL THEN
    RAISE EXCEPTION 'Branch not found or inactive';
  END IF;

  IF NOT public.has_branch_role(
    _user_id,
    _tenant_id,
    _branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden: manager branch access required' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::bigint,
         COALESCE(sum(cs.expected_amount_fils), 0)::bigint,
         COALESCE(sum(cs.counted_cash_fils), 0)::bigint,
         COALESCE(sum(cs.difference_fils), 0)::bigint
    INTO _closed_session_count,
         _expected_amount_fils,
         _counted_cash_fils,
         _difference_fils
    FROM public.cash_sessions cs
   WHERE cs.tenant_id = _tenant_id
     AND cs.branch_id = _branch_id
     AND cs.status = 'closed'
     AND cs.closed_at IS NOT NULL
     AND cs.closed_at >= _start_at
     AND cs.closed_at < _end_at;

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', q.id,
               'opened_at', q.opened_at,
               'closed_at', q.closed_at,
               'expected_amount_fils', q.expected_amount_fils,
               'counted_cash_fils', q.counted_cash_fils,
               'counted_card_fils', q.counted_card_fils,
               'counted_transfer_fils', q.counted_transfer_fils,
               'counted_qr_fils', q.counted_qr_fils,
               'difference_fils', q.difference_fils,
               'total_in_fils', q.total_in_fils,
               'total_out_fils', q.total_out_fils
             )
             ORDER BY q.closed_at DESC, q.id
           ),
           '[]'::jsonb
         )
    INTO _sessions
    FROM (
      SELECT cs.id,
             cs.opened_at,
             cs.closed_at,
             cs.expected_amount_fils,
             cs.counted_cash_fils,
             cs.counted_card_fils,
             cs.counted_transfer_fils,
             cs.counted_qr_fils,
             cs.difference_fils,
             cs.total_in_fils,
             cs.total_out_fils
        FROM public.cash_sessions cs
       WHERE cs.tenant_id = _tenant_id
         AND cs.branch_id = _branch_id
         AND cs.status = 'closed'
         AND cs.closed_at IS NOT NULL
         AND cs.closed_at >= _start_at
         AND cs.closed_at < _end_at
       ORDER BY cs.closed_at DESC, cs.id
       LIMIT 250
    ) q;

  RETURN jsonb_build_object(
    'branch_id', _branch_id,
    'tenant_id', _tenant_id,
    'start_at', _start_at,
    'end_at', _end_at,
    'closed_session_count', _closed_session_count,
    'expected_amount_fils', _expected_amount_fils,
    'counted_cash_fils', _counted_cash_fils,
    'difference_fils', _difference_fils,
    'sessions', _sessions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_cash_till_intelligence_v1(uuid, timestamptz, timestamptz)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_cash_till_intelligence_v1(uuid, timestamptz, timestamptz)
TO authenticated;

COMMENT ON FUNCTION public.get_cash_till_intelligence_v1(uuid, timestamptz, timestamptz) IS
  'P1 authoritative read-only cash/till intelligence from immutable closed-session exact-fils evidence. Manager-scoped and deterministic for an explicit time range.';

COMMIT;
