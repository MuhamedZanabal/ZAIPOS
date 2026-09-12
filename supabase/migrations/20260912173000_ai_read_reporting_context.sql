-- P2 AI read-controller foundation.
-- Exposes only deterministic, server-authorized reporting evidence; no AI mutation authority.

BEGIN;

CREATE OR REPLACE FUNCTION public.ai_read_reporting_context_v1(
  p_branch_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_question text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_question text := btrim(COALESCE(p_question, ''));
  v_snapshot jsonb;
  v_tenant_id uuid;
  v_source_ids jsonb := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF p_branch_id IS NULL OR p_start_at IS NULL OR p_end_at IS NULL OR p_end_at <= p_start_at THEN
    RAISE EXCEPTION 'Invalid AI reporting range';
  END IF;

  IF p_end_at - p_start_at > interval '366 days' THEN
    RAISE EXCEPTION 'AI reporting range exceeds 366 days';
  END IF;

  IF v_question = '' THEN
    RAISE EXCEPTION 'AI question is required';
  END IF;

  IF length(v_question) > 1000 THEN
    RAISE EXCEPTION 'AI question exceeds 1000 characters';
  END IF;

  -- This verified reporting boundary performs the authoritative tenant/branch
  -- authorization check and all exact-fils aggregation. AI receives no table-level
  -- or arbitrary-SQL access through this controller.
  v_snapshot := public.get_branch_reporting_snapshot_v1(p_branch_id, p_start_at, p_end_at);
  v_tenant_id := (v_snapshot ->> 'tenant_id')::uuid;

  SELECT COALESCE(jsonb_agg(sale ->> 'id' ORDER BY sale ->> 'created_at'), '[]'::jsonb)
    INTO v_source_ids
    FROM jsonb_array_elements(COALESCE(v_snapshot -> 'recent_sales', '[]'::jsonb)) AS sale
   WHERE NULLIF(sale ->> 'id', '') IS NOT NULL;

  RETURN jsonb_build_object(
    'mode', 'read_only',
    'question', v_question,
    'fact', v_snapshot,
    'scope', jsonb_build_object(
      'tenant_id', v_tenant_id,
      'branch_id', p_branch_id,
      'start_at', to_char(p_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'end_at', to_char(p_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ),
    'evidence', jsonb_build_object(
      'source_type', 'branch_reporting_snapshot_v1',
      'source_ids', v_source_ids,
      'generated_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'money_unit', 'fils',
      'currency', 'BHD',
      'authoritative', true
    ),
    'limitations', jsonb_build_array(
      'Read-only reporting evidence only',
      'No business-state mutation authority',
      'Facts are limited to the selected branch and time range'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ai_read_reporting_context_v1(uuid, timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_read_reporting_context_v1(uuid, timestamptz, timestamptz, text) FROM anon;
REVOKE ALL ON FUNCTION public.ai_read_reporting_context_v1(uuid, timestamptz, timestamptz, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.ai_read_reporting_context_v1(uuid, timestamptz, timestamptz, text) TO authenticated;

COMMIT;
