-- ZAIPOS P1 supplier accounts-payable subledger.
--
-- Production boundaries:
-- * exact integer fils only
-- * purchase receipt is the payable-recognition event
-- * payable recognition runs in the same DB transaction as purchase-order receipt
-- * payment/opening-balance commands are payload-bound and idempotent
-- * ledger evidence is append-only to authenticated clients
-- * historical received POs are NOT blindly backfilled as unpaid: pre-cutover payment
--   evidence is unavailable, so each branch has an explicit cutover and suppliers remain
--   coverage-incomplete until an opening balance (including zero) is established.

BEGIN;

CREATE TABLE public.supplier_subledger_cutovers (
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id),
  CONSTRAINT supplier_subledger_cutovers_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT
);

INSERT INTO public.supplier_subledger_cutovers(tenant_id, branch_id, activated_at)
SELECT tenant_id, id, now()
FROM public.branches
ON CONFLICT (tenant_id, branch_id) DO NOTHING;

CREATE TABLE public.supplier_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('opening_balance','purchase_receipt','payment')),
  amount_fils bigint NOT NULL CHECK (amount_fils >= 0),
  purchase_order_id uuid,
  operation_id text,
  payment_method text,
  payment_reference text,
  note text,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_ledger_entries_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_ledger_entries_tenant_supplier_fkey
    FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES public.suppliers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_ledger_entries_tenant_purchase_order_fkey
    FOREIGN KEY (tenant_id, purchase_order_id)
    REFERENCES public.purchase_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_ledger_entries_operation_id_check
    CHECK (operation_id IS NULL OR length(btrim(operation_id)) >= 8),
  CONSTRAINT supplier_ledger_entries_shape_check CHECK (
    (entry_type = 'purchase_receipt'
      AND amount_fils > 0
      AND purchase_order_id IS NOT NULL
      AND operation_id IS NULL
      AND payment_method IS NULL)
    OR
    (entry_type = 'payment'
      AND amount_fils > 0
      AND purchase_order_id IS NULL
      AND operation_id IS NOT NULL
      AND payment_method IS NOT NULL)
    OR
    (entry_type = 'opening_balance'
      AND purchase_order_id IS NULL
      AND operation_id IS NOT NULL
      AND payment_method IS NULL)
  )
);

CREATE UNIQUE INDEX supplier_ledger_purchase_receipt_once
  ON public.supplier_ledger_entries(tenant_id, purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;
CREATE UNIQUE INDEX supplier_ledger_operation_once
  ON public.supplier_ledger_entries(tenant_id, operation_id)
  WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX supplier_ledger_opening_once
  ON public.supplier_ledger_entries(tenant_id, branch_id, supplier_id)
  WHERE entry_type = 'opening_balance';
CREATE INDEX supplier_ledger_statement_idx
  ON public.supplier_ledger_entries(tenant_id, branch_id, supplier_id, occurred_at, id);

CREATE TABLE public.supplier_financial_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  operation_id text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('payment','opening_balance')),
  request_hash text NOT NULL,
  request_payload jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  ledger_entry_id uuid REFERENCES public.supplier_ledger_entries(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT supplier_financial_operations_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_financial_operations_tenant_supplier_fkey
    FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES public.suppliers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_financial_operations_operation_id_check
    CHECK (length(btrim(operation_id)) >= 8),
  CONSTRAINT supplier_financial_operations_tenant_operation_key
    UNIQUE (tenant_id, operation_id)
);

ALTER TABLE public.supplier_subledger_cutovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_financial_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY supplier_subledger_cutovers_branch_read ON public.supplier_subledger_cutovers
FOR SELECT TO authenticated USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  )
);
CREATE POLICY supplier_ledger_entries_branch_read ON public.supplier_ledger_entries
FOR SELECT TO authenticated USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  )
);
CREATE POLICY supplier_financial_operations_branch_read ON public.supplier_financial_operations
FOR SELECT TO authenticated USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

REVOKE ALL ON public.supplier_subledger_cutovers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.supplier_ledger_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.supplier_financial_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.supplier_subledger_cutovers TO authenticated;
GRANT SELECT ON public.supplier_ledger_entries TO authenticated;
GRANT SELECT ON public.supplier_financial_operations TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_supplier_financial_operation_internal_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _supplier_id uuid,
  _operation_id text,
  _operation_kind text,
  _request_payload jsonb,
  _actor_id uuid
)
RETURNS TABLE(operation_row_id uuid, is_replay boolean, ledger_entry_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _request_hash text := md5(_request_payload::text);
  _new_id uuid;
  _existing public.supplier_financial_operations;
BEGIN
  INSERT INTO public.supplier_financial_operations(
    tenant_id,branch_id,supplier_id,operation_id,operation_kind,
    request_hash,request_payload,actor_id
  ) VALUES(
    _tenant_id,_branch_id,_supplier_id,_operation_id,_operation_kind,
    _request_hash,_request_payload,_actor_id
  )
  ON CONFLICT (tenant_id, operation_id) DO NOTHING
  RETURNING id INTO _new_id;

  IF _new_id IS NOT NULL THEN
    operation_row_id := _new_id;
    is_replay := false;
    ledger_entry_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO _existing
  FROM public.supplier_financial_operations
  WHERE tenant_id=_tenant_id AND operation_id=_operation_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Could not acquire supplier financial operation'; END IF;
  IF _existing.branch_id IS DISTINCT FROM _branch_id
    OR _existing.supplier_id IS DISTINCT FROM _supplier_id
    OR _existing.operation_kind IS DISTINCT FROM _operation_kind
    OR _existing.request_hash IS DISTINCT FROM _request_hash
    OR _existing.request_payload IS DISTINCT FROM _request_payload
  THEN
    RAISE EXCEPTION 'Supplier financial operation ID was already used with different input';
  END IF;
  IF _existing.completed_at IS NULL OR _existing.ledger_entry_id IS NULL THEN
    RAISE EXCEPTION 'Supplier financial operation did not complete';
  END IF;

  operation_row_id := _existing.id;
  is_replay := true;
  ledger_entry_id := _existing.ledger_entry_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_supplier_financial_operation_internal_v1(uuid,uuid,uuid,text,text,jsonb,uuid)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.post_supplier_purchase_receipt_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _amount_fils bigint;
  _entry_id uuid;
BEGIN
  IF NEW.status <> 'received' OR OLD.status = 'received' THEN RETURN NEW; END IF;
  IF NEW.supplier_id IS NULL THEN
    RAISE EXCEPTION 'Received purchase order requires a supplier for accounts-payable evidence';
  END IF;

  SELECT COALESCE(sum(item.line_total_fils),0)::bigint INTO _amount_fils
  FROM public.purchase_order_items item
  WHERE item.tenant_id=NEW.tenant_id AND item.order_id=NEW.id;

  IF _amount_fils <= 0 THEN
    RAISE EXCEPTION 'Received purchase order requires a positive exact-fils payable amount';
  END IF;

  INSERT INTO public.supplier_ledger_entries(
    tenant_id,branch_id,supplier_id,entry_type,amount_fils,purchase_order_id,
    note,recorded_by,occurred_at
  ) VALUES(
    NEW.tenant_id,NEW.branch_id,NEW.supplier_id,'purchase_receipt',_amount_fils,NEW.id,
    'Purchase order received',auth.uid(),COALESCE(NEW.received_at,now())
  )
  ON CONFLICT (tenant_id,purchase_order_id) WHERE purchase_order_id IS NOT NULL DO NOTHING
  RETURNING id INTO _entry_id;

  IF _entry_id IS NOT NULL AND to_regclass('public.audit_logs') IS NOT NULL THEN
    INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES(
      NEW.tenant_id,auth.uid(),'supplier.purchase_payable_recognized','supplier_ledger_entries',_entry_id,
      jsonb_build_object('branch_id',NEW.branch_id,'supplier_id',NEW.supplier_id,
        'purchase_order_id',NEW.id,'amount_fils',_amount_fils)
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.post_supplier_purchase_receipt_v1()
FROM PUBLIC, anon, authenticated;

CREATE TRIGGER purchase_orders_supplier_payable
AFTER UPDATE OF status ON public.purchase_orders
FOR EACH ROW EXECUTE FUNCTION public.post_supplier_purchase_receipt_v1();

CREATE OR REPLACE FUNCTION public.set_supplier_opening_balance_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _supplier_id uuid,
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
  _request jsonb;
  _claim record;
  _entry_id uuid;
  _cutover_at timestamptz;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(_actor_id,_tenant_id,_branch_id,ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF _amount_fils IS NULL OR _amount_fils < 0 THEN RAISE EXCEPTION 'Opening balance must be nonnegative exact fils'; END IF;
  _reason := btrim(COALESCE(_reason,''));
  _operation_id := btrim(COALESCE(_operation_id,''));
  IF length(_reason) < 3 THEN RAISE EXCEPTION 'Opening balance reason is required'; END IF;
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'Stable supplier financial operation ID is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE tenant_id=_tenant_id AND id=_supplier_id) THEN
    RAISE EXCEPTION 'Supplier does not belong to tenant';
  END IF;
  SELECT activated_at INTO _cutover_at
  FROM public.supplier_subledger_cutovers
  WHERE tenant_id=_tenant_id AND branch_id=_branch_id;
  IF _cutover_at IS NULL THEN RAISE EXCEPTION 'Supplier subledger branch cutover is unavailable'; END IF;

  PERFORM 1 FROM public.suppliers WHERE tenant_id=_tenant_id AND id=_supplier_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.supplier_ledger_entries
    WHERE tenant_id=_tenant_id AND branch_id=_branch_id AND supplier_id=_supplier_id
      AND entry_type='opening_balance'
  ) THEN
    -- A replay is still allowed below if it is the exact original operation.
    NULL;
  END IF;

  _request := jsonb_build_object(
    'tenant_id',_tenant_id,'branch_id',_branch_id,'supplier_id',_supplier_id,
    'amount_fils',_amount_fils,'reason',_reason
  );
  SELECT * INTO _claim FROM public.claim_supplier_financial_operation_internal_v1(
    _tenant_id,_branch_id,_supplier_id,_operation_id,'opening_balance',_request,_actor_id
  );
  IF _claim.is_replay THEN RETURN _claim.ledger_entry_id; END IF;

  IF EXISTS (
    SELECT 1 FROM public.supplier_ledger_entries
    WHERE tenant_id=_tenant_id AND branch_id=_branch_id AND supplier_id=_supplier_id
      AND entry_type='opening_balance'
  ) THEN
    RAISE EXCEPTION 'Supplier opening balance is already established';
  END IF;

  INSERT INTO public.supplier_ledger_entries(
    tenant_id,branch_id,supplier_id,entry_type,amount_fils,operation_id,note,recorded_by,occurred_at
  ) VALUES(
    _tenant_id,_branch_id,_supplier_id,'opening_balance',_amount_fils,_operation_id,_reason,_actor_id,_cutover_at
  ) RETURNING id INTO _entry_id;

  UPDATE public.supplier_financial_operations
  SET ledger_entry_id=_entry_id,completed_at=now()
  WHERE id=_claim.operation_row_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_actor_id,'supplier.opening_balance_set','supplier_ledger_entries',_entry_id,
    jsonb_build_object('branch_id',_branch_id,'supplier_id',_supplier_id,
      'amount_fils',_amount_fils,'operation_id',_operation_id,'reason',_reason));
  RETURN _entry_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_supplier_opening_balance_v1(uuid,uuid,uuid,bigint,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_supplier_opening_balance_v1(uuid,uuid,uuid,bigint,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.record_supplier_payment_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _supplier_id uuid,
  _amount_fils bigint,
  _payment_method text,
  _payment_reference text,
  _note text,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _request jsonb;
  _claim record;
  _entry_id uuid;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(_actor_id,_tenant_id,_branch_id,ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF _amount_fils IS NULL OR _amount_fils <= 0 THEN RAISE EXCEPTION 'Supplier payment must be positive exact fils'; END IF;
  _payment_method := lower(btrim(COALESCE(_payment_method,'')));
  IF _payment_method NOT IN ('cash','card','benefitpay','bank_transfer','cheque','other') THEN
    RAISE EXCEPTION 'Unsupported supplier payment method';
  END IF;
  _payment_reference := NULLIF(btrim(COALESCE(_payment_reference,'')),'');
  _note := NULLIF(btrim(COALESCE(_note,'')),'');
  _operation_id := btrim(COALESCE(_operation_id,''));
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'Stable supplier financial operation ID is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE tenant_id=_tenant_id AND id=_supplier_id) THEN
    RAISE EXCEPTION 'Supplier does not belong to tenant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.supplier_subledger_cutovers
    WHERE tenant_id=_tenant_id AND branch_id=_branch_id
  ) THEN RAISE EXCEPTION 'Supplier subledger branch cutover is unavailable'; END IF;

  -- Serialize supplier financial mutations so concurrent payments cannot interleave
  -- their evidence and replay handling unpredictably.
  PERFORM 1 FROM public.suppliers WHERE tenant_id=_tenant_id AND id=_supplier_id FOR UPDATE;

  _request := jsonb_build_object(
    'tenant_id',_tenant_id,'branch_id',_branch_id,'supplier_id',_supplier_id,
    'amount_fils',_amount_fils,'payment_method',_payment_method,
    'payment_reference',_payment_reference,'note',_note
  );
  SELECT * INTO _claim FROM public.claim_supplier_financial_operation_internal_v1(
    _tenant_id,_branch_id,_supplier_id,_operation_id,'payment',_request,_actor_id
  );
  IF _claim.is_replay THEN RETURN _claim.ledger_entry_id; END IF;

  INSERT INTO public.supplier_ledger_entries(
    tenant_id,branch_id,supplier_id,entry_type,amount_fils,operation_id,
    payment_method,payment_reference,note,recorded_by
  ) VALUES(
    _tenant_id,_branch_id,_supplier_id,'payment',_amount_fils,_operation_id,
    _payment_method,_payment_reference,_note,_actor_id
  ) RETURNING id INTO _entry_id;

  UPDATE public.supplier_financial_operations
  SET ledger_entry_id=_entry_id,completed_at=now()
  WHERE id=_claim.operation_row_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_actor_id,'supplier.payment_recorded','supplier_ledger_entries',_entry_id,
    jsonb_build_object('branch_id',_branch_id,'supplier_id',_supplier_id,
      'amount_fils',_amount_fils,'payment_method',_payment_method,
      'payment_reference',_payment_reference,'operation_id',_operation_id));
  RETURN _entry_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_supplier_payment_v1(uuid,uuid,uuid,bigint,text,text,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_supplier_payment_v1(uuid,uuid,uuid,bigint,text,text,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.get_supplier_statement_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _supplier_id uuid
)
RETURNS TABLE(
  entry_id uuid,
  entry_type text,
  occurred_at timestamptz,
  amount_fils bigint,
  balance_delta_fils bigint,
  running_balance_fils bigint,
  purchase_order_id uuid,
  payment_method text,
  payment_reference text,
  note text,
  coverage_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _has_opening boolean;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(
    _actor_id,_tenant_id,_branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE tenant_id=_tenant_id AND id=_supplier_id) THEN
    RAISE EXCEPTION 'Supplier does not belong to tenant';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.supplier_ledger_entries
    WHERE tenant_id=_tenant_id AND branch_id=_branch_id AND supplier_id=_supplier_id
      AND entry_type='opening_balance'
  ) INTO _has_opening;

  RETURN QUERY
  WITH ordered AS (
    SELECT e.*,
      CASE WHEN e.entry_type='payment' THEN -e.amount_fils ELSE e.amount_fils END AS delta
    FROM public.supplier_ledger_entries e
    WHERE e.tenant_id=_tenant_id AND e.branch_id=_branch_id AND e.supplier_id=_supplier_id
  )
  SELECT
    o.id,o.entry_type,o.occurred_at,o.amount_fils,o.delta,
    sum(o.delta) OVER (ORDER BY o.occurred_at,o.id ROWS UNBOUNDED PRECEDING)::bigint,
    o.purchase_order_id,o.payment_method,o.payment_reference,o.note,
    CASE WHEN _has_opening THEN 'complete_from_cutover' ELSE 'opening_balance_required' END
  FROM ordered o
  ORDER BY o.occurred_at,o.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_supplier_statement_v1(uuid,uuid,uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_supplier_statement_v1(uuid,uuid,uuid)
TO authenticated;

COMMENT ON FUNCTION public.get_supplier_statement_v1(uuid,uuid,uuid) IS
  'Branch-scoped supplier AP statement. Coverage is complete from cutover only after an explicit opening balance (including zero) is recorded; legacy received POs are never presumed unpaid.';

COMMIT;
