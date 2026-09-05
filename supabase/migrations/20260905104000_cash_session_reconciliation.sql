-- ZAIPOS P0.6: exact cash-session reconciliation.
--
-- Preserve the existing close_cash_session RPC signature used by the live Cash
-- screen, but make the server calculation authoritative in integer fils. Reject
-- sub-fils counted inputs instead of allowing NUMERIC column rounding to create
-- a mismatch between counted buckets and the closing aggregate.

BEGIN;

CREATE OR REPLACE FUNCTION public.close_cash_session(
  _session_id uuid,
  _counted_amount numeric,
  _notes text DEFAULT NULL,
  _counted_card numeric DEFAULT NULL,
  _counted_transfer numeric DEFAULT NULL,
  _counted_qr numeric DEFAULT NULL
)
RETURNS public.cash_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _s public.cash_sessions;
  _counted_cash_value numeric := COALESCE(_counted_amount, 0);
  _counted_card_value numeric := COALESCE(_counted_card, 0);
  _counted_transfer_value numeric := COALESCE(_counted_transfer, 0);
  _counted_qr_value numeric := COALESCE(_counted_qr, 0);
  _counted_cash_fils bigint;
  _counted_card_fils bigint;
  _counted_transfer_fils bigint;
  _counted_qr_fils bigint;
  _expected_cash_numeric numeric;
  _expected_total_numeric numeric;
  _counted_total_numeric numeric;
  _expected_cash_fils bigint;
  _expected_total_fils bigint;
  _counted_total_fils bigint;
  _difference_fils bigint;
  _updated public.cash_sessions;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO _s
  FROM public.cash_sessions
  WHERE id = _session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cash session not found';
  END IF;
  IF _s.status <> 'open' THEN
    RAISE EXCEPTION 'Cash session is already closed';
  END IF;
  IF NOT public.has_branch_role(
    auth.uid(),
    _s.tenant_id,
    _s.branch_id,
    ARRAY['owner','admin','manager','cashier']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF _counted_cash_value <> round(_counted_cash_value, 3)
     OR _counted_card_value <> round(_counted_card_value, 3)
     OR _counted_transfer_value <> round(_counted_transfer_value, 3)
     OR _counted_qr_value <> round(_counted_qr_value, 3)
  THEN
    RAISE EXCEPTION 'Counted amounts support at most three decimal places';
  END IF;

  IF _counted_cash_value < 0
     OR _counted_card_value < 0
     OR _counted_transfer_value < 0
     OR _counted_qr_value < 0
  THEN
    RAISE EXCEPTION 'Counted amounts cannot be negative';
  END IF;

  _counted_cash_fils := public.bhd_numeric_to_fils(_counted_cash_value);
  _counted_card_fils := public.bhd_numeric_to_fils(_counted_card_value);
  _counted_transfer_fils := public.bhd_numeric_to_fils(_counted_transfer_value);
  _counted_qr_fils := public.bhd_numeric_to_fils(_counted_qr_value);

  -- Cast the first operand to NUMERIC before addition so extreme but valid
  -- individual BIGINT sidecars cannot overflow during intermediate arithmetic.
  _expected_cash_numeric :=
      _s.opening_amount_fils::numeric
    + _s.total_cash_fils
    + _s.total_in_fils
    - _s.total_out_fils;
  _expected_total_numeric :=
      _expected_cash_numeric
    + _s.total_card_fils
    + _s.total_transfer_fils
    + _s.total_qr_fils;
  _counted_total_numeric :=
      _counted_cash_fils::numeric
    + _counted_card_fils
    + _counted_transfer_fils
    + _counted_qr_fils;

  IF _expected_cash_numeric NOT BETWEEN -9223372036854775808::numeric AND 9223372036854775807::numeric
     OR _expected_total_numeric NOT BETWEEN -9223372036854775808::numeric AND 9223372036854775807::numeric
     OR _counted_total_numeric NOT BETWEEN 0::numeric AND 9223372036854775807::numeric
  THEN
    RAISE EXCEPTION 'Cash-session reconciliation exceeds the supported fils range';
  END IF;

  _expected_cash_fils := _expected_cash_numeric::bigint;
  _expected_total_fils := _expected_total_numeric::bigint;
  _counted_total_fils := _counted_total_numeric::bigint;

  IF (_counted_total_fils::numeric - _expected_total_fils::numeric)
       NOT BETWEEN -9223372036854775808::numeric AND 9223372036854775807::numeric
  THEN
    RAISE EXCEPTION 'Cash-session difference exceeds the supported fils range';
  END IF;
  _difference_fils := (_counted_total_fils::numeric - _expected_total_fils::numeric)::bigint;

  UPDATE public.cash_sessions
  SET status = 'closed',
      closed_at = now(),
      counted_cash = public.fils_to_bhd_numeric(_counted_cash_fils),
      counted_card = public.fils_to_bhd_numeric(_counted_card_fils),
      counted_transfer = public.fils_to_bhd_numeric(_counted_transfer_fils),
      counted_qr = public.fils_to_bhd_numeric(_counted_qr_fils),
      closing_amount = public.fils_to_bhd_numeric(_counted_total_fils),
      expected_amount = public.fils_to_bhd_numeric(_expected_total_fils),
      difference = public.fils_to_bhd_numeric(_difference_fils),
      notes = _notes
  WHERE id = _session_id
  RETURNING * INTO _updated;

  INSERT INTO public.audit_logs (
    tenant_id,
    user_id,
    action,
    entity,
    entity_id,
    metadata
  ) VALUES (
    _s.tenant_id,
    auth.uid(),
    'cash_session.closed',
    'cash_sessions',
    _session_id,
    jsonb_build_object(
      'branch_id', _s.branch_id,
      'expected_cash_fils', _expected_cash_fils,
      'expected_total_fils', _expected_total_fils,
      'counted_total_fils', _counted_total_fils,
      'difference_fils', _difference_fils,
      'expected_total', public.fils_to_bhd_numeric(_expected_total_fils),
      'counted_total', public.fils_to_bhd_numeric(_counted_total_fils)
    )
  );

  RETURN _updated;
END;
$$;

REVOKE ALL ON FUNCTION public.close_cash_session(uuid, numeric, text, numeric, numeric, numeric)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_cash_session(uuid, numeric, text, numeric, numeric, numeric)
TO authenticated;

COMMENT ON FUNCTION public.close_cash_session(uuid, numeric, text, numeric, numeric, numeric) IS
  'P0.6 exact-fils register close. Rejects sub-fils counted input, reconciles from cash-session fils sidecars, records exact audit evidence, and preserves the installed-client RPC signature.';

COMMIT;
