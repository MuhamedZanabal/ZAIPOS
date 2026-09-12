-- P1 customer loyalty ledger: immutable per-sale award evidence and exact compensating reversals.
--
-- The existing checkout policy is preserved: floor(total_fils / 1000) * points_per_thousand.
-- New checkout awards are snapshotted from the authoritative checkout operation in the
-- same transaction. Historical balances receive opening evidence only; historical sales
-- without exact award evidence remain fail-closed for return/void rather than fabricating
-- a past policy snapshot.

BEGIN;

CREATE TABLE public.customer_loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  points_delta bigint NOT NULL,
  points_per_thousand_snapshot bigint,
  sale_id uuid REFERENCES public.sales(id) ON DELETE RESTRICT,
  return_id uuid REFERENCES public.sale_returns(id) ON DELETE RESTRICT,
  void_id uuid REFERENCES public.sale_voids(id) ON DELETE RESTRICT,
  operation_id text NOT NULL,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_loyalty_event_type CHECK (
    event_type IN ('opening_balance','sale_earn','return_reversal','void_reversal')
  ),
  CONSTRAINT customer_loyalty_operation_id CHECK (length(trim(operation_id)) >= 8),
  CONSTRAINT customer_loyalty_policy_snapshot CHECK (
    points_per_thousand_snapshot IS NULL OR points_per_thousand_snapshot >= 0
  ),
  CONSTRAINT customer_loyalty_branch_fk
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id)
    ON DELETE RESTRICT,
  UNIQUE (tenant_id, operation_id)
);

CREATE UNIQUE INDEX uq_customer_loyalty_sale_earn
  ON public.customer_loyalty_ledger(tenant_id, sale_id)
  WHERE event_type = 'sale_earn' AND sale_id IS NOT NULL;
CREATE UNIQUE INDEX uq_customer_loyalty_return_reversal
  ON public.customer_loyalty_ledger(tenant_id, return_id)
  WHERE event_type = 'return_reversal' AND return_id IS NOT NULL;
CREATE UNIQUE INDEX uq_customer_loyalty_void_reversal
  ON public.customer_loyalty_ledger(tenant_id, void_id)
  WHERE event_type = 'void_reversal' AND void_id IS NOT NULL;
CREATE INDEX idx_customer_loyalty_customer_created
  ON public.customer_loyalty_ledger(tenant_id, customer_id, created_at, id);
CREATE INDEX idx_customer_loyalty_sale
  ON public.customer_loyalty_ledger(tenant_id, sale_id, created_at, id)
  WHERE sale_id IS NOT NULL;

ALTER TABLE public.customer_loyalty_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_loyalty_ledger_member_select
ON public.customer_loyalty_ledger
FOR SELECT TO authenticated
USING (public.is_tenant_member(auth.uid(), tenant_id));

REVOKE ALL ON public.customer_loyalty_ledger FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_loyalty_ledger TO authenticated;

-- Preserve every pre-ledger aggregate without claiming which historical sale earned it.
INSERT INTO public.customer_loyalty_ledger (
  tenant_id,
  branch_id,
  customer_id,
  event_type,
  points_delta,
  points_per_thousand_snapshot,
  operation_id,
  request_payload,
  actor_id
)
SELECT
  c.tenant_id,
  NULL,
  c.id,
  'opening_balance',
  COALESCE(c.loyalty_points, 0)::bigint,
  NULL,
  'legacy-opening:' || c.id::text,
  jsonb_build_object('source', 'customers.loyalty_points', 'cutover', '20260912090000'),
  NULL
FROM public.customers c
WHERE COALESCE(c.loyalty_points, 0) <> 0
ON CONFLICT (tenant_id, operation_id) DO NOTHING;

-- Checkout already mutates the aggregate before writing its authoritative operation_log
-- row. Capturing the immutable evidence from that operation keeps the award and evidence
-- in the same transaction without introducing a second financial/customer authority.
CREATE OR REPLACE FUNCTION public.capture_checkout_loyalty_evidence_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _sale public.sales;
  _points_per_thousand bigint;
  _points_earned bigint;
BEGIN
  IF NEW.operation_type IS DISTINCT FROM 'checkout_sale_v2'
     OR NEW.entity_type IS DISTINCT FROM 'sales'
     OR NEW.entity_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _sale
  FROM public.sales
  WHERE id = NEW.entity_id
    AND tenant_id = NEW.tenant_id;

  IF NOT FOUND OR _sale.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(points_per_thousand, 0)::bigint
  INTO _points_per_thousand
  FROM public.tenants
  WHERE id = _sale.tenant_id;

  _points_earned := floor(_sale.total_fils::numeric / 1000)::bigint * _points_per_thousand;

  INSERT INTO public.customer_loyalty_ledger (
    tenant_id,
    branch_id,
    customer_id,
    event_type,
    points_delta,
    points_per_thousand_snapshot,
    sale_id,
    operation_id,
    request_payload,
    actor_id
  ) VALUES (
    _sale.tenant_id,
    _sale.branch_id,
    _sale.customer_id,
    'sale_earn',
    _points_earned,
    _points_per_thousand,
    _sale.id,
    'sale:' || _sale.id::text,
    jsonb_build_object(
      'checkout_client_mutation_id', NEW.client_mutation_id,
      'total_fils', _sale.total_fils,
      'points_per_thousand_snapshot', _points_per_thousand,
      'points_earned', _points_earned
    ),
    _sale.user_id
  )
  ON CONFLICT (tenant_id, sale_id)
    WHERE event_type = 'sale_earn' AND sale_id IS NOT NULL
  DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS capture_checkout_loyalty_evidence ON public.operation_log;
CREATE TRIGGER capture_checkout_loyalty_evidence
AFTER INSERT OR UPDATE ON public.operation_log
FOR EACH ROW
EXECUTE FUNCTION public.capture_checkout_loyalty_evidence_v1();

-- Historical customer-linked sales remain blocked because their exact policy snapshot is
-- unknowable. New sales are returnable once the sale_earn evidence exists.
CREATE OR REPLACE FUNCTION public.guard_customer_linked_return_without_loyalty_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _tenant_id uuid;
  _customer_id uuid;
BEGIN
  SELECT tenant_id, customer_id
  INTO _tenant_id, _customer_id
  FROM public.sales
  WHERE id = NEW.original_sale_id;

  IF _customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.customer_loyalty_ledger l
    WHERE l.tenant_id = _tenant_id
      AND l.sale_id = NEW.original_sale_id
      AND l.event_type = 'sale_earn'
  ) THEN
    RAISE EXCEPTION 'Customer-linked return requires exact loyalty reversal evidence before it can be processed';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_return_loyalty_reversal_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _sale public.sales;
  _award public.customer_loyalty_ledger;
  _cumulative_return_fils bigint;
  _remaining_total_fils bigint;
  _target_points bigint;
  _current_sale_points bigint;
  _delta bigint;
  _customer_points bigint;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed'
     OR OLD.status IS NOT DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _sale
  FROM public.sales
  WHERE id = NEW.original_sale_id
  FOR UPDATE;

  IF NOT FOUND OR _sale.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _award
  FROM public.customer_loyalty_ledger
  WHERE tenant_id = _sale.tenant_id
    AND sale_id = _sale.id
    AND event_type = 'sale_earn'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer-linked return is missing exact sale loyalty evidence';
  END IF;

  SELECT COALESCE(sum(amount_fils), 0)::bigint
  INTO _cumulative_return_fils
  FROM public.sale_returns
  WHERE original_sale_id = _sale.id
    AND status = 'completed';

  _remaining_total_fils := GREATEST(_sale.total_fils - _cumulative_return_fils, 0);
  _target_points := floor(_remaining_total_fils::numeric / 1000)::bigint
    * COALESCE(_award.points_per_thousand_snapshot, 0);

  SELECT COALESCE(sum(points_delta), 0)::bigint
  INTO _current_sale_points
  FROM public.customer_loyalty_ledger
  WHERE tenant_id = _sale.tenant_id
    AND sale_id = _sale.id
    AND event_type IN ('sale_earn','return_reversal','void_reversal');

  _delta := _target_points - _current_sale_points;
  IF _delta > 0 THEN
    RAISE EXCEPTION 'Return loyalty reversal would increase sale-earned points';
  END IF;

  SELECT COALESCE(loyalty_points, 0)::bigint
  INTO _customer_points
  FROM public.customers
  WHERE id = _sale.customer_id
    AND tenant_id = _sale.tenant_id
  FOR UPDATE;

  IF _customer_points + _delta < 0 THEN
    RAISE EXCEPTION 'Customer loyalty balance is insufficient for exact return reversal';
  END IF;

  INSERT INTO public.customer_loyalty_ledger (
    tenant_id, branch_id, customer_id, event_type, points_delta,
    points_per_thousand_snapshot, sale_id, return_id, operation_id,
    request_payload, actor_id
  ) VALUES (
    _sale.tenant_id, _sale.branch_id, _sale.customer_id, 'return_reversal', _delta,
    _award.points_per_thousand_snapshot, _sale.id, NEW.id, 'return:' || NEW.id::text,
    jsonb_build_object(
      'return_amount_fils', NEW.amount_fils,
      'cumulative_return_fils', _cumulative_return_fils,
      'remaining_total_fils', _remaining_total_fils,
      'previous_sale_points', _current_sale_points,
      'target_sale_points', _target_points
    ), NEW.user_id
  );

  IF _delta <> 0 THEN
    UPDATE public.customers
    SET loyalty_points = loyalty_points + _delta
    WHERE id = _sale.customer_id
      AND tenant_id = _sale.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS apply_return_loyalty_reversal ON public.sale_returns;
CREATE TRIGGER apply_return_loyalty_reversal
AFTER UPDATE OF status ON public.sale_returns
FOR EACH ROW
EXECUTE FUNCTION public.apply_return_loyalty_reversal_v1();

CREATE OR REPLACE FUNCTION public.apply_void_loyalty_reversal_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _sale public.sales;
  _award public.customer_loyalty_ledger;
  _current_sale_points bigint;
  _delta bigint;
  _customer_points bigint;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed'
     OR OLD.status IS NOT DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _sale
  FROM public.sales
  WHERE id = NEW.sale_id
  FOR UPDATE;

  IF NOT FOUND OR _sale.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _award
  FROM public.customer_loyalty_ledger
  WHERE tenant_id = _sale.tenant_id
    AND sale_id = _sale.id
    AND event_type = 'sale_earn'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer-linked sale void is missing exact loyalty reversal evidence';
  END IF;

  SELECT COALESCE(sum(points_delta), 0)::bigint
  INTO _current_sale_points
  FROM public.customer_loyalty_ledger
  WHERE tenant_id = _sale.tenant_id
    AND sale_id = _sale.id
    AND event_type IN ('sale_earn','return_reversal','void_reversal');

  _delta := -_current_sale_points;
  IF _delta > 0 THEN
    RAISE EXCEPTION 'Sale loyalty evidence is inconsistent for void reversal';
  END IF;

  SELECT COALESCE(loyalty_points, 0)::bigint
  INTO _customer_points
  FROM public.customers
  WHERE id = _sale.customer_id
    AND tenant_id = _sale.tenant_id
  FOR UPDATE;

  IF _customer_points + _delta < 0 THEN
    RAISE EXCEPTION 'Customer loyalty balance is insufficient for exact void reversal';
  END IF;

  INSERT INTO public.customer_loyalty_ledger (
    tenant_id, branch_id, customer_id, event_type, points_delta,
    points_per_thousand_snapshot, sale_id, void_id, operation_id,
    request_payload, actor_id
  ) VALUES (
    _sale.tenant_id, _sale.branch_id, _sale.customer_id, 'void_reversal', _delta,
    _award.points_per_thousand_snapshot, _sale.id, NEW.id, 'void:' || NEW.id::text,
    jsonb_build_object(
      'previous_sale_points', _current_sale_points,
      'target_sale_points', 0,
      'sale_total_fils', _sale.total_fils
    ), NEW.user_id
  );

  IF _delta <> 0 THEN
    UPDATE public.customers
    SET loyalty_points = loyalty_points + _delta
    WHERE id = _sale.customer_id
      AND tenant_id = _sale.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS apply_void_loyalty_reversal ON public.sale_voids;
CREATE TRIGGER apply_void_loyalty_reversal
AFTER UPDATE OF status ON public.sale_voids
FOR EACH ROW
EXECUTE FUNCTION public.apply_void_loyalty_reversal_v1();

-- The old void command blocks every customer-linked sale before a void row can exist.
-- Remove only that obsolete fail-closed block; the completion trigger above now performs
-- the exact reversal and still raises/rolls back if evidence is absent or inconsistent.
DO $patch$
DECLARE
  _definition text;
  _patched text;
  _obsolete text := $obsolete$
  -- Checkout currently mutates customer.loyalty_points without persisting the
  -- awarded delta on the sale. Recomputing it from today's tenant settings
  -- would fabricate reversal evidence, so customer-linked voids fail closed
  -- until the dedicated loyalty-ledger phase records the exact award.
  IF _sale.customer_id IS NOT NULL THEN
    RAISE EXCEPTION 'Customer-linked sale void requires loyalty reversal evidence';
  END IF;
$obsolete$;
BEGIN
  SELECT pg_get_functiondef('public.process_sale_void_v2(uuid,text,uuid,text)'::regprocedure)
  INTO _definition;

  _patched := replace(
    _definition,
    _obsolete,
    E'\n  -- Customer-linked voids are permitted only when the immutable loyalty ledger can reverse the exact sale award.\n'
  );

  IF _patched = _definition THEN
    RAISE EXCEPTION 'Could not locate the legacy customer-linked void loyalty guard';
  END IF;

  EXECUTE _patched;
END;
$patch$;

COMMENT ON TABLE public.customer_loyalty_ledger IS
  'Immutable customer loyalty evidence. Sale awards snapshot the policy used; return and void rows are compensating events. Historical aggregate balances are preserved as opening evidence without inventing per-sale history.';
COMMENT ON FUNCTION public.capture_checkout_loyalty_evidence_v1() IS
  'Captures immutable sale loyalty award evidence atomically from checkout_sale_v2 operation_log completion.';
COMMENT ON FUNCTION public.apply_return_loyalty_reversal_v1() IS
  'Recomputes sale-earned loyalty after cumulative completed returns using the original sale policy snapshot and records the exact compensating delta.';
COMMENT ON FUNCTION public.apply_void_loyalty_reversal_v1() IS
  'Reverses the exact remaining sale-earned loyalty points when a sale void completes.';

COMMIT;
