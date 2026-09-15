-- ZAIPOS P0: exactly-once manual cash movements.
--
-- A manual cash movement changes physical till money. A response can be lost
-- after commit, so retries must use one durable reference and replay the exact
-- original effect rather than create another movement. Record/cancel share one
-- serialized operation identity and the legacy mutation RPC is no longer a
-- client authority.

BEGIN;

CREATE TABLE public.cash_movement_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES public.cash_sessions(id) ON DELETE RESTRICT,
  reference text NOT NULL,
  movement_type text NOT NULL,
  amount_fils bigint NOT NULL,
  reason text NOT NULL,
  state text NOT NULL,
  movement_id uuid UNIQUE REFERENCES public.cash_movements(id) ON DELETE RESTRICT,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_movement_operations_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT cash_movement_operations_reference CHECK (length(reference) BETWEEN 8 AND 128 AND reference = btrim(reference)),
  CONSTRAINT cash_movement_operations_type CHECK (movement_type IN ('in','out')),
  CONSTRAINT cash_movement_operations_amount CHECK (amount_fils > 0),
  CONSTRAINT cash_movement_operations_reason CHECK (length(reason) BETWEEN 2 AND 500 AND reason = btrim(reason)),
  CONSTRAINT cash_movement_operations_state CHECK (state IN ('recorded','cancelled')),
  CONSTRAINT cash_movement_operations_effect CHECK (
    (state = 'recorded' AND movement_id IS NOT NULL)
    OR (state = 'cancelled' AND movement_id IS NULL)
  ),
  UNIQUE (tenant_id, reference)
);

CREATE INDEX cash_movement_operations_branch_created_idx
  ON public.cash_movement_operations(branch_id, created_at DESC);

ALTER TABLE public.cash_movement_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_movement_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cash_movement_operations TO authenticated;

CREATE POLICY cash_movement_operations_branch_select_v1
ON public.cash_movement_operations
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager','cashier']::public.app_role[]
  )
);

CREATE OR REPLACE FUNCTION public.prevent_cash_movement_operation_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Cash movement operation evidence is immutable';
END;
$$;
REVOKE ALL ON FUNCTION public.prevent_cash_movement_operation_mutation_v1()
FROM PUBLIC, anon, authenticated;

CREATE TRIGGER cash_movement_operations_immutable
BEFORE UPDATE OR DELETE ON public.cash_movement_operations
FOR EACH ROW EXECUTE FUNCTION public.prevent_cash_movement_operation_mutation_v1();

-- The v2 RPC is the sole authenticated client authority. SECURITY DEFINER code
-- may still call the hardened primitive so existing exact-fils, user/employee,
-- branch and audit invariants remain centralized there.
REVOKE ALL ON FUNCTION public.add_cash_movement(uuid,text,numeric,text)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_cash_movement_v2(
  _session_id uuid,
  _type text,
  _amount numeric,
  _reason text,
  _reference text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _s public.cash_sessions;
  _existing public.cash_movement_operations;
  _mv public.cash_movements;
  _amount_fils bigint;
  _reason_value text := btrim(coalesce(_reason, ''));
  _reference_value text := btrim(coalesce(_reference, ''));
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _type IS NULL OR _type NOT IN ('in','out') THEN RAISE EXCEPTION 'Invalid cash movement type'; END IF;
  IF _amount IS NULL OR _amount <= 0 OR _amount <> round(_amount, 3)
     OR _amount::text IN ('NaN','Infinity','-Infinity')
  THEN RAISE EXCEPTION 'Cash amount must be positive exact fils'; END IF;
  IF length(_reason_value) NOT BETWEEN 2 AND 500 THEN
    RAISE EXCEPTION 'Cash movement reason must contain 2 to 500 characters';
  END IF;
  IF length(_reference_value) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'Cash movement reference must contain 8 to 128 characters';
  END IF;
  _amount_fils := public.bhd_numeric_to_fils(_amount);

  SELECT * INTO _s FROM public.cash_sessions WHERE id = _session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cash session not found'; END IF;
  IF NOT public.has_branch_role(
    _user_id, _s.tenant_id, _s.branch_id,
    ARRAY['owner','admin','manager','cashier']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = _s.branch_id AND tenant_id = _s.tenant_id AND status = 'active'
  ) THEN RAISE EXCEPTION 'Branch is not active'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = _user_id AND deleted_at IS NULL
      AND (banned_until IS NULL OR banned_until <= now())
  ) THEN RAISE EXCEPTION 'User is not active'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.employees
    WHERE user_id = _user_id AND tenant_id = _s.tenant_id
      AND (branch_id IS NULL OR branch_id = _s.branch_id)
      AND status = 'inactive'
  ) THEN RAISE EXCEPTION 'Employee is not active'; END IF;

  -- Record and cancel for one reference must converge to one terminal state.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(_s.tenant_id::text),
    pg_catalog.hashtext(_reference_value)
  );

  SELECT * INTO _existing
  FROM public.cash_movement_operations
  WHERE tenant_id = _s.tenant_id AND reference = _reference_value;

  IF FOUND THEN
    IF _existing.branch_id IS DISTINCT FROM _s.branch_id
       OR _existing.session_id IS DISTINCT FROM _session_id
       OR _existing.movement_type IS DISTINCT FROM _type
       OR _existing.amount_fils IS DISTINCT FROM _amount_fils
       OR _existing.reason IS DISTINCT FROM _reason_value
    THEN
      RAISE EXCEPTION 'Cash movement reference was already used for a different request';
    END IF;
    IF _existing.state = 'recorded' THEN
      RETURN _existing.movement_id;
    END IF;
    RAISE EXCEPTION 'Cash movement reference was cancelled';
  END IF;

  IF _s.status <> 'open' THEN RAISE EXCEPTION 'Cash session is not open'; END IF;

  SELECT * INTO _mv
  FROM public.add_cash_movement(
    _session_id,
    _type,
    public.fils_to_bhd_numeric(_amount_fils),
    _reason_value
  );

  INSERT INTO public.cash_movement_operations(
    tenant_id, branch_id, session_id, reference, movement_type,
    amount_fils, reason, state, movement_id, requested_by
  ) VALUES (
    _s.tenant_id, _s.branch_id, _session_id, _reference_value, _type,
    _amount_fils, _reason_value, 'recorded', _mv.id, _user_id
  );

  RETURN _mv.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_cash_movement_v2(
  _session_id uuid,
  _type text,
  _amount numeric,
  _reason text,
  _reference text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _s public.cash_sessions;
  _existing public.cash_movement_operations;
  _operation_id uuid;
  _amount_fils bigint;
  _reason_value text := btrim(coalesce(_reason, ''));
  _reference_value text := btrim(coalesce(_reference, ''));
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _type IS NULL OR _type NOT IN ('in','out') THEN RAISE EXCEPTION 'Invalid cash movement type'; END IF;
  IF _amount IS NULL OR _amount <= 0 OR _amount <> round(_amount, 3)
     OR _amount::text IN ('NaN','Infinity','-Infinity')
  THEN RAISE EXCEPTION 'Cash amount must be positive exact fils'; END IF;
  IF length(_reason_value) NOT BETWEEN 2 AND 500 THEN
    RAISE EXCEPTION 'Cash movement reason must contain 2 to 500 characters';
  END IF;
  IF length(_reference_value) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'Cash movement reference must contain 8 to 128 characters';
  END IF;
  _amount_fils := public.bhd_numeric_to_fils(_amount);

  SELECT * INTO _s FROM public.cash_sessions WHERE id = _session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cash session not found'; END IF;
  IF NOT public.has_branch_role(
    _user_id, _s.tenant_id, _s.branch_id,
    ARRAY['owner','admin','manager','cashier']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = _s.branch_id AND tenant_id = _s.tenant_id AND status = 'active'
  ) THEN RAISE EXCEPTION 'Branch is not active'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = _user_id AND deleted_at IS NULL
      AND (banned_until IS NULL OR banned_until <= now())
  ) THEN RAISE EXCEPTION 'User is not active'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.employees
    WHERE user_id = _user_id AND tenant_id = _s.tenant_id
      AND (branch_id IS NULL OR branch_id = _s.branch_id)
      AND status = 'inactive'
  ) THEN RAISE EXCEPTION 'Employee is not active'; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(_s.tenant_id::text),
    pg_catalog.hashtext(_reference_value)
  );

  SELECT * INTO _existing
  FROM public.cash_movement_operations
  WHERE tenant_id = _s.tenant_id AND reference = _reference_value;

  IF FOUND THEN
    IF _existing.branch_id IS DISTINCT FROM _s.branch_id
       OR _existing.session_id IS DISTINCT FROM _session_id
       OR _existing.movement_type IS DISTINCT FROM _type
       OR _existing.amount_fils IS DISTINCT FROM _amount_fils
       OR _existing.reason IS DISTINCT FROM _reason_value
    THEN
      RAISE EXCEPTION 'Cash movement reference was already used for a different request';
    END IF;
    IF _existing.state = 'recorded' THEN
      RETURN _existing.movement_id;
    END IF;
    RETURN NULL;
  END IF;

  IF _s.status <> 'open' THEN RAISE EXCEPTION 'Cash session is not open'; END IF;

  INSERT INTO public.cash_movement_operations(
    tenant_id, branch_id, session_id, reference, movement_type,
    amount_fils, reason, state, movement_id, requested_by
  ) VALUES (
    _s.tenant_id, _s.branch_id, _session_id, _reference_value, _type,
    _amount_fils, _reason_value, 'cancelled', NULL, _user_id
  )
  RETURNING id INTO _operation_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(
    _s.tenant_id, _user_id, 'cash.movement_cancelled',
    'cash_movement_operations', _operation_id,
    jsonb_build_object(
      'branch_id', _s.branch_id,
      'session_id', _session_id,
      'reference', _reference_value,
      'type', _type,
      'amount_fils', _amount_fils
    )
  );

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.record_cash_movement_v2(uuid,text,numeric,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_cash_movement_v2(uuid,text,numeric,text,text)
TO authenticated;

REVOKE ALL ON FUNCTION public.cancel_cash_movement_v2(uuid,text,numeric,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_cash_movement_v2(uuid,text,numeric,text,text)
TO authenticated;

COMMENT ON FUNCTION public.record_cash_movement_v2(uuid,text,numeric,text,text) IS
  'Exactly-once manual cash mutation. Stable tenant reference is payload-bound, replays the original movement after uncertain responses, and serializes against cancellation.';
COMMENT ON FUNCTION public.cancel_cash_movement_v2(uuid,text,numeric,text,text) IS
  'Claims or observes a manual-cash reference without reversing committed physical money. Concurrent record/cancel converges to one terminal operation state.';

COMMIT;
