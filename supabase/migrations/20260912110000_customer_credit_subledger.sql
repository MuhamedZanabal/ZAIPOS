-- ZAIPOS P1 customer accounts-receivable credit subledger.
--
-- Production boundaries:
-- * all monetary truth is integer fils
-- * customer receivables are reconstructed from immutable ledger entries
-- * balance/limit caches are server-authoritative and updated atomically with ledger evidence
-- * financial operation IDs are stable, idempotent, and payload-bound
-- * authenticated clients cannot directly mutate account, ledger, or operation tables
-- * managers control limits, verified openings, and manual charges
-- * authorized cashiers may record repayments, but cannot alter limits/history
-- * credit-limit and overpayment constraints fail closed under row locking
-- * all successful financial mutations emit audit evidence

BEGIN;

CREATE TABLE public.customer_credit_accounts (
  customer_id uuid PRIMARY KEY REFERENCES public.customers(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  credit_limit_fils bigint NOT NULL DEFAULT 0 CHECK (credit_limit_fils >= 0),
  balance_fils bigint NOT NULL DEFAULT 0 CHECK (balance_fils >= 0),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_credit_accounts_balance_limit_check
    CHECK (balance_fils <= credit_limit_fils),
  CONSTRAINT customer_credit_accounts_tenant_customer_key
    UNIQUE (tenant_id, customer_id)
);
CREATE INDEX customer_credit_accounts_tenant_idx
  ON public.customer_credit_accounts(tenant_id, customer_id);

CREATE TABLE public.customer_credit_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (entry_type IN ('opening_balance','charge','payment')),
  amount_fils bigint NOT NULL,
  source_kind text,
  source_reference text,
  operation_id text NOT NULL,
  note text,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_credit_entries_operation_id_check
    CHECK (length(btrim(operation_id)) >= 8),
  CONSTRAINT customer_credit_entries_shape_check CHECK (
    (entry_type = 'opening_balance' AND amount_fils >= 0)
    OR (entry_type = 'charge' AND amount_fils > 0)
    OR (entry_type = 'payment' AND amount_fils < 0)
  ),
  CONSTRAINT customer_credit_entries_tenant_customer_fkey
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES public.customer_credit_accounts(tenant_id, customer_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX customer_credit_entries_operation_once
  ON public.customer_credit_entries(tenant_id, operation_id);
CREATE UNIQUE INDEX customer_credit_entries_opening_once
  ON public.customer_credit_entries(tenant_id, customer_id)
  WHERE entry_type = 'opening_balance';
CREATE INDEX customer_credit_entries_statement_idx
  ON public.customer_credit_entries(tenant_id, customer_id, occurred_at, id);

CREATE TABLE public.customer_credit_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  operation_id text NOT NULL,
  command text NOT NULL CHECK (command IN ('set_limit','opening_balance','charge','payment')),
  request_hash text NOT NULL,
  request_payload jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  result_id uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_credit_operations_operation_id_check
    CHECK (length(btrim(operation_id)) >= 8),
  CONSTRAINT customer_credit_operations_tenant_operation_key
    UNIQUE (tenant_id, operation_id)
);
CREATE INDEX customer_credit_operations_customer_idx
  ON public.customer_credit_operations(tenant_id, customer_id, created_at, id);

ALTER TABLE public.customer_credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_credit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_credit_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_credit_accounts_member_select ON public.customer_credit_accounts
FOR SELECT TO authenticated
USING (public.is_tenant_member(auth.uid(), tenant_id));

CREATE POLICY customer_credit_entries_member_select ON public.customer_credit_entries
FOR SELECT TO authenticated
USING (public.is_tenant_member(auth.uid(), tenant_id));

CREATE POLICY customer_credit_operations_actor_or_manager_select ON public.customer_credit_operations
FOR SELECT TO authenticated
USING (
  actor_id = auth.uid()
  OR public.has_any_role(
    auth.uid(), tenant_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

REVOKE ALL ON public.customer_credit_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.customer_credit_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.customer_credit_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_credit_accounts TO authenticated;
GRANT SELECT ON public.customer_credit_entries TO authenticated;
GRANT SELECT ON public.customer_credit_operations TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_customer_credit_operation_internal_v1(
  _tenant_id uuid,
  _customer_id uuid,
  _operation_id text,
  _command text,
  _request_payload jsonb,
  _actor_id uuid
)
RETURNS TABLE(operation_row_id uuid, is_replay boolean, result_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _request_hash text := md5(_request_payload::text);
  _new_id uuid;
  _existing public.customer_credit_operations;
BEGIN
  INSERT INTO public.customer_credit_operations(
    tenant_id, customer_id, operation_id, command,
    request_hash, request_payload, actor_id
  ) VALUES(
    _tenant_id, _customer_id, _operation_id, _command,
    _request_hash, _request_payload, _actor_id
  )
  ON CONFLICT (tenant_id, operation_id) DO NOTHING
  RETURNING id INTO _new_id;

  IF _new_id IS NOT NULL THEN
    operation_row_id := _new_id;
    is_replay := false;
    result_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO _existing
  FROM public.customer_credit_operations op
  WHERE op.tenant_id = _tenant_id
    AND op.operation_id = _operation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not acquire customer credit operation';
  END IF;

  IF _existing.customer_id IS DISTINCT FROM _customer_id
    OR _existing.command IS DISTINCT FROM _command
    OR _existing.request_hash IS DISTINCT FROM _request_hash
    OR _existing.request_payload IS DISTINCT FROM _request_payload
  THEN
    RAISE EXCEPTION 'Customer credit operation ID was already used with different payload';
  END IF;

  IF _existing.completed_at IS NULL OR _existing.result_id IS NULL THEN
    RAISE EXCEPTION 'Customer credit operation did not complete';
  END IF;

  operation_row_id := _existing.id;
  is_replay := true;
  result_id := _existing.result_id;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_customer_credit_operation_internal_v1(uuid,uuid,text,text,jsonb,uuid)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ensure_customer_credit_account_internal_v1(
  _tenant_id uuid,
  _customer_id uuid,
  _actor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.customers c
    WHERE c.id = _customer_id AND c.tenant_id = _tenant_id
  ) THEN
    RAISE EXCEPTION 'Customer does not belong to tenant';
  END IF;

  INSERT INTO public.customer_credit_accounts(customer_id, tenant_id, updated_by)
  VALUES(_customer_id, _tenant_id, _actor_id)
  ON CONFLICT (customer_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM public.customer_credit_accounts a
    WHERE a.customer_id = _customer_id AND a.tenant_id = _tenant_id
  ) THEN
    RAISE EXCEPTION 'Customer credit account tenant mismatch';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_customer_credit_account_internal_v1(uuid,uuid,uuid)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_customer_credit_limit_v1(
  _customer_id uuid,
  _limit_fils bigint,
  _reason text,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _tenant_id uuid;
  _request jsonb;
  _claim record;
  _balance_fils bigint;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _limit_fils IS NULL OR _limit_fils < 0 THEN
    RAISE EXCEPTION 'Credit limit must be nonnegative exact fils';
  END IF;
  _reason := btrim(COALESCE(_reason,''));
  _operation_id := btrim(COALESCE(_operation_id,''));
  IF length(_reason) < 3 THEN RAISE EXCEPTION 'Credit limit reason is required'; END IF;
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'Stable customer credit operation ID is required'; END IF;

  _tenant_id := public.resolve_customer_command_tenant_v1(_actor_id, _customer_id);
  IF NOT public.has_any_role(
    _actor_id, _tenant_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden: manager role required for customer credit limit';
  END IF;

  _request := jsonb_build_object(
    'customer_id',_customer_id,'limit_fils',_limit_fils,'reason',_reason
  );
  SELECT * INTO _claim
  FROM public.claim_customer_credit_operation_internal_v1(
    _tenant_id,_customer_id,_operation_id,'set_limit',_request,_actor_id
  );
  IF _claim.is_replay THEN RETURN _customer_id; END IF;

  PERFORM public.ensure_customer_credit_account_internal_v1(_tenant_id,_customer_id,_actor_id);
  SELECT a.balance_fils INTO _balance_fils
  FROM public.customer_credit_accounts a
  WHERE a.customer_id = _customer_id
  FOR UPDATE;

  IF _balance_fils > _limit_fils THEN
    RAISE EXCEPTION 'Credit limit cannot be below current balance';
  END IF;

  UPDATE public.customer_credit_accounts
  SET credit_limit_fils = _limit_fils,
      updated_by = _actor_id,
      updated_at = now()
  WHERE customer_id = _customer_id AND tenant_id = _tenant_id;

  UPDATE public.customer_credit_operations
  SET result_id = _customer_id, completed_at = now()
  WHERE id = _claim.operation_row_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(
    _tenant_id,_actor_id,'customer.credit_limit_set','customer_credit_accounts',_customer_id,
    jsonb_build_object('limit_fils',_limit_fils,'reason',_reason,'operation_id',_operation_id)
  );

  RETURN _customer_id;
END;
$$;
REVOKE ALL ON FUNCTION public.set_customer_credit_limit_v1(uuid,bigint,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_customer_credit_limit_v1(uuid,bigint,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.set_customer_credit_opening_balance_v1(
  _customer_id uuid,
  _amount_fils bigint,
  _reason text,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _tenant_id uuid;
  _request jsonb;
  _claim record;
  _entry_id uuid;
  _balance_fils bigint;
  _limit_fils bigint;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _amount_fils IS NULL OR _amount_fils < 0 THEN
    RAISE EXCEPTION 'Opening balance must be nonnegative exact fils';
  END IF;
  _reason := btrim(COALESCE(_reason,''));
  _operation_id := btrim(COALESCE(_operation_id,''));
  IF length(_reason) < 3 THEN RAISE EXCEPTION 'Opening balance reason is required'; END IF;
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'Stable customer credit operation ID is required'; END IF;

  _tenant_id := public.resolve_customer_command_tenant_v1(_actor_id, _customer_id);
  IF NOT public.has_any_role(
    _actor_id, _tenant_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden: manager role required for customer credit opening balance';
  END IF;

  _request := jsonb_build_object(
    'customer_id',_customer_id,'amount_fils',_amount_fils,'reason',_reason
  );
  SELECT * INTO _claim
  FROM public.claim_customer_credit_operation_internal_v1(
    _tenant_id,_customer_id,_operation_id,'opening_balance',_request,_actor_id
  );
  IF _claim.is_replay THEN RETURN _claim.result_id; END IF;

  PERFORM public.ensure_customer_credit_account_internal_v1(_tenant_id,_customer_id,_actor_id);
  SELECT a.balance_fils,a.credit_limit_fils
  INTO _balance_fils,_limit_fils
  FROM public.customer_credit_accounts a
  WHERE a.customer_id = _customer_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.customer_credit_entries e
    WHERE e.tenant_id = _tenant_id
      AND e.customer_id = _customer_id
      AND e.entry_type = 'opening_balance'
  ) THEN
    RAISE EXCEPTION 'Customer credit opening balance is already established';
  END IF;

  IF _balance_fils + _amount_fils > _limit_fils THEN
    RAISE EXCEPTION 'Opening balance exceeds approved credit limit';
  END IF;

  INSERT INTO public.customer_credit_entries(
    tenant_id,customer_id,entry_type,amount_fils,source_kind,source_reference,
    operation_id,note,recorded_by
  ) VALUES(
    _tenant_id,_customer_id,'opening_balance',_amount_fils,'legacy_receivable',NULL,
    _operation_id,_reason,_actor_id
  ) RETURNING id INTO _entry_id;

  UPDATE public.customer_credit_accounts
  SET balance_fils = balance_fils + _amount_fils,
      updated_by = _actor_id,
      updated_at = now()
  WHERE customer_id = _customer_id AND tenant_id = _tenant_id;

  UPDATE public.customer_credit_operations
  SET result_id = _entry_id, completed_at = now()
  WHERE id = _claim.operation_row_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(
    _tenant_id,_actor_id,'customer.credit_opening_balance_set','customer_credit_entries',_entry_id,
    jsonb_build_object('customer_id',_customer_id,'amount_fils',_amount_fils,
      'reason',_reason,'operation_id',_operation_id)
  );

  RETURN _entry_id;
END;
$$;
REVOKE ALL ON FUNCTION public.set_customer_credit_opening_balance_v1(uuid,bigint,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_customer_credit_opening_balance_v1(uuid,bigint,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.record_customer_credit_charge_v1(
  _customer_id uuid,
  _amount_fils bigint,
  _source_kind text,
  _source_reference text,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _tenant_id uuid;
  _request jsonb;
  _claim record;
  _entry_id uuid;
  _balance_fils bigint;
  _limit_fils bigint;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _amount_fils IS NULL OR _amount_fils <= 0 THEN
    RAISE EXCEPTION 'Customer credit charge must be positive exact fils';
  END IF;
  _source_kind := btrim(COALESCE(_source_kind,''));
  _source_reference := btrim(COALESCE(_source_reference,''));
  _operation_id := btrim(COALESCE(_operation_id,''));
  IF length(_source_kind) < 2 THEN RAISE EXCEPTION 'Credit charge source kind is required'; END IF;
  IF length(_source_reference) < 2 THEN RAISE EXCEPTION 'Credit charge source reference is required'; END IF;
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'Stable customer credit operation ID is required'; END IF;

  _tenant_id := public.resolve_customer_command_tenant_v1(_actor_id, _customer_id);
  IF NOT public.has_any_role(
    _actor_id, _tenant_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden: manager role required for manual customer credit charge';
  END IF;

  _request := jsonb_build_object(
    'customer_id',_customer_id,'amount_fils',_amount_fils,
    'source_kind',_source_kind,'source_reference',_source_reference
  );
  SELECT * INTO _claim
  FROM public.claim_customer_credit_operation_internal_v1(
    _tenant_id,_customer_id,_operation_id,'charge',_request,_actor_id
  );
  IF _claim.is_replay THEN RETURN _claim.result_id; END IF;

  PERFORM public.ensure_customer_credit_account_internal_v1(_tenant_id,_customer_id,_actor_id);
  SELECT a.balance_fils,a.credit_limit_fils
  INTO _balance_fils,_limit_fils
  FROM public.customer_credit_accounts a
  WHERE a.customer_id = _customer_id
  FOR UPDATE;

  IF _balance_fils + _amount_fils > _limit_fils THEN
    RAISE EXCEPTION 'Customer credit limit would be exceeded';
  END IF;

  INSERT INTO public.customer_credit_entries(
    tenant_id,customer_id,entry_type,amount_fils,source_kind,source_reference,
    operation_id,note,recorded_by
  ) VALUES(
    _tenant_id,_customer_id,'charge',_amount_fils,_source_kind,_source_reference,
    _operation_id,NULL,_actor_id
  ) RETURNING id INTO _entry_id;

  UPDATE public.customer_credit_accounts
  SET balance_fils = balance_fils + _amount_fils,
      updated_by = _actor_id,
      updated_at = now()
  WHERE customer_id = _customer_id AND tenant_id = _tenant_id;

  UPDATE public.customer_credit_operations
  SET result_id = _entry_id, completed_at = now()
  WHERE id = _claim.operation_row_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(
    _tenant_id,_actor_id,'customer.credit_charge_recorded','customer_credit_entries',_entry_id,
    jsonb_build_object('customer_id',_customer_id,'amount_fils',_amount_fils,
      'source_kind',_source_kind,'source_reference',_source_reference,
      'operation_id',_operation_id)
  );

  RETURN _entry_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_customer_credit_charge_v1(uuid,bigint,text,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_customer_credit_charge_v1(uuid,bigint,text,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.record_customer_credit_payment_v1(
  _customer_id uuid,
  _amount_fils bigint,
  _payment_method text,
  _payment_reference text,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _tenant_id uuid;
  _request jsonb;
  _claim record;
  _entry_id uuid;
  _balance_fils bigint;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _amount_fils IS NULL OR _amount_fils <= 0 THEN
    RAISE EXCEPTION 'Customer credit payment must be positive exact fils';
  END IF;
  _payment_method := lower(btrim(COALESCE(_payment_method,'')));
  _payment_reference := btrim(COALESCE(_payment_reference,''));
  _operation_id := btrim(COALESCE(_operation_id,''));
  IF _payment_method NOT IN ('cash','card','benefitpay','bank_transfer','cheque','other') THEN
    RAISE EXCEPTION 'Unsupported customer credit payment method';
  END IF;
  IF length(_payment_reference) < 2 THEN RAISE EXCEPTION 'Customer credit payment reference is required'; END IF;
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'Stable customer credit operation ID is required'; END IF;

  _tenant_id := public.resolve_customer_command_tenant_v1(_actor_id, _customer_id);
  IF NOT public.has_any_role(
    _actor_id, _tenant_id,
    ARRAY['owner','admin','manager','cashier']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden: authorized cashier role required for customer credit payment';
  END IF;

  _request := jsonb_build_object(
    'customer_id',_customer_id,'amount_fils',_amount_fils,
    'payment_method',_payment_method,'payment_reference',_payment_reference
  );
  SELECT * INTO _claim
  FROM public.claim_customer_credit_operation_internal_v1(
    _tenant_id,_customer_id,_operation_id,'payment',_request,_actor_id
  );
  IF _claim.is_replay THEN RETURN _claim.result_id; END IF;

  PERFORM public.ensure_customer_credit_account_internal_v1(_tenant_id,_customer_id,_actor_id);
  SELECT a.balance_fils INTO _balance_fils
  FROM public.customer_credit_accounts a
  WHERE a.customer_id = _customer_id
  FOR UPDATE;

  IF _amount_fils > _balance_fils THEN
    RAISE EXCEPTION 'Customer credit payment would overpay receivable balance';
  END IF;

  INSERT INTO public.customer_credit_entries(
    tenant_id,customer_id,entry_type,amount_fils,source_kind,source_reference,
    operation_id,note,recorded_by
  ) VALUES(
    _tenant_id,_customer_id,'payment',-_amount_fils,_payment_method,_payment_reference,
    _operation_id,NULL,_actor_id
  ) RETURNING id INTO _entry_id;

  UPDATE public.customer_credit_accounts
  SET balance_fils = balance_fils - _amount_fils,
      updated_by = _actor_id,
      updated_at = now()
  WHERE customer_id = _customer_id AND tenant_id = _tenant_id;

  UPDATE public.customer_credit_operations
  SET result_id = _entry_id, completed_at = now()
  WHERE id = _claim.operation_row_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(
    _tenant_id,_actor_id,'customer.credit_payment_recorded','customer_credit_entries',_entry_id,
    jsonb_build_object('customer_id',_customer_id,'amount_fils',_amount_fils,
      'payment_method',_payment_method,'payment_reference',_payment_reference,
      'operation_id',_operation_id)
  );

  RETURN _entry_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_customer_credit_payment_v1(uuid,bigint,text,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_customer_credit_payment_v1(uuid,bigint,text,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.get_customer_credit_statement_v1(
  _customer_id uuid
)
RETURNS TABLE(
  id uuid,
  entry_type text,
  amount_fils bigint,
  source_kind text,
  source_reference text,
  note text,
  recorded_by uuid,
  occurred_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _tenant_id uuid;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  _tenant_id := public.resolve_customer_command_tenant_v1(_actor_id, _customer_id);

  RETURN QUERY
  SELECT e.id,e.entry_type,e.amount_fils,e.source_kind,e.source_reference,
         e.note,e.recorded_by,e.occurred_at,e.created_at
  FROM public.customer_credit_entries e
  WHERE e.tenant_id = _tenant_id
    AND e.customer_id = _customer_id
  ORDER BY e.occurred_at,e.id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_customer_credit_statement_v1(uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_credit_statement_v1(uuid)
TO authenticated;

COMMIT;
