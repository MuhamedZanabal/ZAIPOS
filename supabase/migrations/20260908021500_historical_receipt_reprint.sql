-- Immutable historical receipt snapshots and audited reprint lifecycle.
--
-- Existing sales are backfilled once from their persisted sale rows. New sale
-- snapshots are captured at transaction commit, after items and payments exist.

BEGIN;

ALTER TABLE public.sales
  ADD COLUMN receipt_snapshot jsonb;

CREATE OR REPLACE FUNCTION public.build_sale_receipt_snapshot(_sale_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'schema_version', 1,
    'sale_id', s.id,
    'ticket_number', s.ticket_number,
    'transaction_time', s.created_at,
    'business', jsonb_build_object(
      'name', t.name,
      'receipt_config', COALESCE(t.receipt_config, '{}'::jsonb)
    ),
    'branch', jsonb_build_object(
      'id', b.id,
      'name', b.name,
      'address', b.address,
      'phone', b.phone
    ),
    'cashier', jsonb_build_object(
      'id', s.user_id,
      'name', COALESCE(p.full_name, p.email, 'Unknown cashier')
    ),
    'customer', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'phone', c.phone
    ) END,
    'channel', s.channel,
    'totals', jsonb_build_object(
      'subtotal_fils', s.subtotal_fils,
      'discount_total_fils', s.discount_total_fils,
      'tax_total_fils', s.tax_total_fils,
      'tip_amount_fils', s.tip_amount_fils,
      'total_fils', s.total_fils
    ),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', si.id,
        'product_id', si.product_id,
        'name', si.product_name,
        'product_type', si.product_type,
        'quantity', si.quantity,
        'unit_price_fils', si.unit_price_fils,
        'discount_fils', si.discount_fils,
        'line_total_fils', si.line_total_fils,
        'tax_rate', si.tax_rate,
        'modifiers', COALESCE(si.modifiers, '[]'::jsonb)
      ) ORDER BY si.created_at, si.id)
      FROM public.sale_items si
      WHERE si.sale_id = s.id AND si.tenant_id = s.tenant_id
    ), '[]'::jsonb),
    'payments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', pay.id,
        'method', pay.method,
        'amount_fils', pay.amount_fils,
        'reference', pay.reference
      ) ORDER BY pay.created_at, pay.id)
      FROM public.payments pay
      WHERE pay.sale_id = s.id AND pay.tenant_id = s.tenant_id
    ), '[]'::jsonb)
  )
  FROM public.sales s
  JOIN public.tenants t ON t.id = s.tenant_id
  JOIN public.branches b ON b.id = s.branch_id AND b.tenant_id = s.tenant_id
  LEFT JOIN public.profiles p ON p.id = s.user_id
  LEFT JOIN public.customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
  WHERE s.id = _sale_id;
$$;

REVOKE ALL ON FUNCTION public.build_sale_receipt_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;

UPDATE public.sales s
SET receipt_snapshot = public.build_sale_receipt_snapshot(s.id)
WHERE s.receipt_snapshot IS NULL;

ALTER TABLE public.sales
  ADD CONSTRAINT sales_receipt_snapshot_object_check
  CHECK (receipt_snapshot IS NULL OR jsonb_typeof(receipt_snapshot) = 'object');

CREATE OR REPLACE FUNCTION public.capture_sale_receipt_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.sales
  SET receipt_snapshot = public.build_sale_receipt_snapshot(NEW.id)
  WHERE id = NEW.id AND receipt_snapshot IS NULL;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_sale_receipt_snapshot()
  FROM PUBLIC, anon, authenticated;

CREATE CONSTRAINT TRIGGER capture_sale_receipt_snapshot_at_commit
AFTER INSERT ON public.sales
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.capture_sale_receipt_snapshot();

CREATE OR REPLACE FUNCTION public.prevent_sale_receipt_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.receipt_snapshot IS DISTINCT FROM NEW.receipt_snapshot
     AND current_user NOT IN ('postgres', 'supabase_admin', 'service_role') THEN
    RAISE EXCEPTION 'Historical receipt snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_sale_receipt_snapshot_mutation()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER prevent_sale_receipt_snapshot_mutation
BEFORE UPDATE OF receipt_snapshot ON public.sales
FOR EACH ROW
EXECUTE FUNCTION public.prevent_sale_receipt_snapshot_mutation();

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sales'::regclass
      AND conname = 'sales_tenant_branch_id_key'
  ) THEN
    ALTER TABLE public.sales
      ADD CONSTRAINT sales_tenant_branch_id_key UNIQUE (tenant_id, branch_id, id);
  END IF;
END
$migration$;

CREATE TABLE public.receipt_reprint_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  client_operation_id text NOT NULL CHECK (
    length(trim(client_operation_id)) BETWEEN 8 AND 200
  ),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'printed', 'failed')),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT receipt_reprint_events_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT receipt_reprint_events_sale_fkey
    FOREIGN KEY (tenant_id, branch_id, sale_id)
    REFERENCES public.sales(tenant_id, branch_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, client_operation_id)
);

CREATE INDEX receipt_reprint_events_sale_created_idx
  ON public.receipt_reprint_events(tenant_id, branch_id, sale_id, created_at DESC);

ALTER TABLE public.receipt_reprint_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY receipt_reprint_events_branch_select
ON public.receipt_reprint_events
FOR SELECT
TO authenticated
USING (public.has_branch_role(
  (SELECT auth.uid()),
  tenant_id,
  branch_id,
  ARRAY['owner','admin','manager','cashier']::public.app_role[]
));

REVOKE ALL ON TABLE public.receipt_reprint_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.receipt_reprint_events TO authenticated;

CREATE OR REPLACE FUNCTION public.prepare_sale_receipt_reprint_v1(
  _sale_id uuid,
  _client_operation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor uuid := auth.uid();
  _sale public.sales%ROWTYPE;
  _event public.receipt_reprint_events%ROWTYPE;
  _created boolean := false;
BEGIN
  IF _actor IS NULL THEN
    RAISE EXCEPTION 'Receipt reprint is not authorized';
  END IF;
  IF length(trim(COALESCE(_client_operation_id, ''))) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'A valid receipt reprint operation ID is required';
  END IF;

  SELECT * INTO _sale
  FROM public.sales
  WHERE id = _sale_id;

  IF NOT FOUND OR NOT public.has_branch_role(
    _actor,
    _sale.tenant_id,
    _sale.branch_id,
    ARRAY['owner','admin','manager','cashier']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Receipt reprint is not authorized';
  END IF;

  IF _sale.receipt_snapshot IS NULL THEN
    RAISE EXCEPTION 'Historical receipt snapshot is unavailable';
  END IF;

  INSERT INTO public.receipt_reprint_events(
    tenant_id, branch_id, sale_id, requested_by, client_operation_id
  ) VALUES (
    _sale.tenant_id, _sale.branch_id, _sale.id, _actor, trim(_client_operation_id)
  )
  ON CONFLICT (tenant_id, client_operation_id) DO NOTHING
  RETURNING * INTO _event;

  IF FOUND THEN
    _created := true;
  ELSE
    SELECT * INTO _event
    FROM public.receipt_reprint_events
    WHERE tenant_id = _sale.tenant_id
      AND client_operation_id = trim(_client_operation_id)
    FOR UPDATE;

    IF _event.sale_id <> _sale.id OR _event.requested_by <> _actor THEN
      RAISE EXCEPTION 'Receipt reprint operation ID conflicts with another request';
    END IF;
  END IF;

  IF _created THEN
    INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES (
      _sale.tenant_id,
      _actor,
      'sale.receipt_reprint_requested',
      'sales',
      _sale.id,
      jsonb_build_object(
        'branch_id', _sale.branch_id,
        'reprint_event_id', _event.id,
        'client_operation_id', _event.client_operation_id,
        'ticket_number', _sale.ticket_number
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'event_id', _event.id,
    'current_status', _sale.status,
    'snapshot', _sale.receipt_snapshot
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_sale_receipt_reprint_v1(uuid,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_sale_receipt_reprint_v1(uuid,text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_sale_receipt_reprint_v1(
  _event_id uuid,
  _outcome text,
  _failure_code text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor uuid := auth.uid();
  _event public.receipt_reprint_events%ROWTYPE;
BEGIN
  IF _actor IS NULL OR _outcome NOT IN ('printed', 'failed') THEN
    RAISE EXCEPTION 'Receipt reprint completion is not authorized';
  END IF;
  IF _outcome = 'failed' AND NULLIF(trim(COALESCE(_failure_code, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A failure code is required for a failed reprint';
  END IF;
  IF _failure_code IS NOT NULL AND length(_failure_code) > 64 THEN
    RAISE EXCEPTION 'Receipt reprint failure code is too long';
  END IF;

  SELECT * INTO _event
  FROM public.receipt_reprint_events
  WHERE id = _event_id
  FOR UPDATE;

  IF NOT FOUND
     OR _event.requested_by <> _actor
     OR NOT public.has_branch_role(
       _actor,
       _event.tenant_id,
       _event.branch_id,
       ARRAY['owner','admin','manager','cashier']::public.app_role[]
     ) THEN
    RAISE EXCEPTION 'Receipt reprint completion is not authorized';
  END IF;

  IF _event.status <> 'requested' THEN
    IF _event.status = _outcome
       AND _event.failure_code IS NOT DISTINCT FROM NULLIF(trim(_failure_code), '') THEN
      RETURN _event.id;
    END IF;
    RAISE EXCEPTION 'Receipt reprint outcome conflicts with the recorded result';
  END IF;

  UPDATE public.receipt_reprint_events
  SET status = _outcome,
      failure_code = CASE WHEN _outcome = 'failed' THEN trim(_failure_code) ELSE NULL END,
      completed_at = now()
  WHERE id = _event.id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (
    _event.tenant_id,
    _actor,
    CASE WHEN _outcome = 'printed'
      THEN 'sale.receipt_reprint_printed'
      ELSE 'sale.receipt_reprint_failed'
    END,
    'sales',
    _event.sale_id,
    jsonb_build_object(
      'branch_id', _event.branch_id,
      'reprint_event_id', _event.id,
      'client_operation_id', _event.client_operation_id,
      'failure_code', CASE WHEN _outcome = 'failed' THEN trim(_failure_code) ELSE NULL END
    )
  );

  RETURN _event.id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_sale_receipt_reprint_v1(uuid,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_sale_receipt_reprint_v1(uuid,text,text)
  TO authenticated;

COMMIT;
