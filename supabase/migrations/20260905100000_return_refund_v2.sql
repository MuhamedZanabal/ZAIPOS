-- ZAIPOS P0.6: exact, idempotent return/refund lifecycle.
--
-- Historical sales and original payments remain immutable. Returns are
-- compensating transactions with exact fils, relational item/payment evidence,
-- an explicit operation ID, branch-scoped manager authorization, exactly-once
-- inventory restoration, and current-session payment bucket effects.

BEGIN;

ALTER TABLE public.sale_returns
  ADD COLUMN IF NOT EXISTS amount_fils bigint,
  ADD COLUMN IF NOT EXISTS reason_code text,
  ADD COLUMN IF NOT EXISTS client_mutation_id text,
  ADD COLUMN IF NOT EXISTS request_payload jsonb,
  ADD COLUMN IF NOT EXISTS cash_session_id uuid REFERENCES public.cash_sessions(id) ON DELETE RESTRICT;

UPDATE public.sale_returns
SET amount_fils = public.bhd_numeric_to_fils(amount)
WHERE amount_fils IS NULL;

ALTER TABLE public.sale_returns
  ALTER COLUMN amount_fils SET NOT NULL;

ALTER TABLE public.sale_returns
  DROP CONSTRAINT IF EXISTS sale_returns_original_sale_id_fkey;
ALTER TABLE public.sale_returns
  ADD CONSTRAINT sale_returns_original_sale_id_fkey
  FOREIGN KEY (original_sale_id) REFERENCES public.sales(id) ON DELETE RESTRICT;

ALTER TABLE public.sale_returns
  ADD CONSTRAINT sale_returns_amount_nonnegative_v2 CHECK (amount_fils >= 0),
  ADD CONSTRAINT sale_returns_amount_parity_v2 CHECK (
    amount_fils = public.bhd_numeric_to_fils(amount)
  ),
  ADD CONSTRAINT sale_returns_operation_id_v2 CHECK (
    client_mutation_id IS NULL OR length(trim(client_mutation_id)) >= 8
  ),
  ADD CONSTRAINT sale_returns_reason_code_v2 CHECK (
    reason_code IS NULL OR reason_code IN (
      'damaged', 'wrong_item', 'quality', 'customer_request', 'other', 'void'
    )
  ),
  ADD CONSTRAINT sale_returns_status_v2 CHECK (status IN ('processing', 'completed'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_returns_client_mutation_v2
  ON public.sale_returns(tenant_id, client_mutation_id)
  WHERE client_mutation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sale_returns_original_sale_v2
  ON public.sale_returns(original_sale_id, created_at);

DROP TRIGGER IF EXISTS sync_sale_returns_fils ON public.sale_returns;
CREATE TRIGGER sync_sale_returns_fils
BEFORE INSERT OR UPDATE ON public.sale_returns
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"amount":"amount_fils"}'
);

CREATE TABLE public.sale_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  return_id uuid NOT NULL REFERENCES public.sale_returns(id) ON DELETE RESTRICT,
  sale_item_id uuid NOT NULL REFERENCES public.sale_items(id) ON DELETE RESTRICT,
  product_id uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  quantity numeric(12,3) NOT NULL,
  amount numeric(14,3) NOT NULL,
  amount_fils bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sale_return_items_quantity_positive CHECK (
    quantity > 0 AND quantity = round(quantity, 3)
  ),
  CONSTRAINT sale_return_items_amount_nonnegative CHECK (amount_fils >= 0),
  CONSTRAINT sale_return_items_amount_parity CHECK (
    amount_fils = public.bhd_numeric_to_fils(amount)
  ),
  UNIQUE(return_id, sale_item_id)
);

CREATE INDEX idx_sale_return_items_sale_item
  ON public.sale_return_items(sale_item_id);

CREATE TRIGGER sync_sale_return_items_fils
BEFORE INSERT OR UPDATE ON public.sale_return_items
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"amount":"amount_fils"}'
);

CREATE TABLE public.payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  return_id uuid NOT NULL REFERENCES public.sale_returns(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  cash_session_id uuid REFERENCES public.cash_sessions(id) ON DELETE RESTRICT,
  method public.payment_method NOT NULL,
  amount numeric(14,3) NOT NULL,
  amount_fils bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_refunds_amount_positive CHECK (amount_fils > 0),
  CONSTRAINT payment_refunds_amount_parity CHECK (
    amount_fils = public.bhd_numeric_to_fils(amount)
  ),
  UNIQUE(return_id, payment_id)
);

CREATE INDEX idx_payment_refunds_payment
  ON public.payment_refunds(payment_id, created_at);

CREATE TRIGGER sync_payment_refunds_fils
BEFORE INSERT OR UPDATE ON public.payment_refunds
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"amount":"amount_fils"}'
);

-- Historical financial rows are command-owned. Authenticated clients may read
-- according to RLS but may not directly rewrite/delete committed history.
REVOKE UPDATE, DELETE ON public.sales FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.sale_items FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.payments FROM authenticated, anon;

DROP POLICY IF EXISTS returns_member_select ON public.sale_returns;
DROP POLICY IF EXISTS returns_admin_all ON public.sale_returns;
DROP POLICY IF EXISTS sale_returns_branch_select_v2 ON public.sale_returns;
CREATE POLICY sale_returns_branch_select_v2
ON public.sale_returns
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

ALTER TABLE public.sale_return_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY sale_return_items_branch_select_v2
ON public.sale_return_items
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

ALTER TABLE public.payment_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_refunds_branch_select_v2
ON public.payment_refunds
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

REVOKE INSERT, UPDATE, DELETE ON public.sale_returns FROM authenticated, anon;
REVOKE ALL ON public.sale_return_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payment_refunds FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sale_returns TO authenticated;
GRANT SELECT ON public.sale_return_items TO authenticated;
GRANT SELECT ON public.payment_refunds TO authenticated;

-- A return movement is keyed by the immutable return-item row, so a bug or
-- replay cannot restore the same line twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_return_item_effect
  ON public.inventory_movements(tenant_id, reference_type, reference_id, movement_type)
  WHERE reference_type = 'sale_return_item'
    AND movement_type = 'return'::public.movement_type;

CREATE OR REPLACE FUNCTION public.process_sale_return_v2(
  _sale_id uuid,
  _items jsonb,
  _reason_code text,
  _client_mutation_id text,
  _cash_session_id uuid DEFAULT NULL,
  _reason text DEFAULT NULL,
  _evidence_url text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _sale public.sales;
  _existing_return public.sale_returns;
  _return_id uuid;
  _request_payload jsonb;
  _normalized_reason_code text;
  _item jsonb;
  _sale_item public.sale_items;
  _return_item_id uuid;
  _quantity numeric;
  _already_quantity numeric;
  _already_item_refund_fils bigint;
  _gross_items_fils bigint;
  _merchandise_pool_fils bigint;
  _item_pool_fils bigint;
  _target_item_refund_fils bigint;
  _line_refund_fils bigint;
  _return_total_fils bigint := 0;
  _prior_return_total_fils bigint;
  _new_cumulative_return_fils bigint;
  _payment record;
  _original_payment_total_fils bigint;
  _payment_cumulative_fils bigint := 0;
  _previous_payment_target_fils bigint := 0;
  _payment_target_cumulative_fils bigint;
  _payment_target_fils bigint;
  _already_payment_refunded_fils bigint;
  _payment_refund_fils bigint;
  _payment_refund_total_fils bigint := 0;
  _resulting_status public.sale_status;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF _items IS NULL OR jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Return must contain at least one sale item';
  END IF;

  _client_mutation_id := NULLIF(trim(COALESCE(_client_mutation_id, '')), '');
  IF _client_mutation_id IS NULL OR length(_client_mutation_id) < 8 THEN
    RAISE EXCEPTION 'A stable client mutation ID is required for return/refund';
  END IF;

  _normalized_reason_code := lower(trim(COALESCE(_reason_code, '')));
  IF _normalized_reason_code NOT IN ('damaged','wrong_item','quality','customer_request','other','void') THEN
    RAISE EXCEPTION 'A valid return reason code is required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT value->>'sale_item_id' AS sale_item_id
      FROM jsonb_array_elements(_items)
    ) q
    WHERE NULLIF(q.sale_item_id, '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Every returned item requires a sale item ID';
  END IF;

  IF (
    SELECT count(*)
    FROM jsonb_array_elements(_items)
  ) <> (
    SELECT count(DISTINCT value->>'sale_item_id')
    FROM jsonb_array_elements(_items)
  ) THEN
    RAISE EXCEPTION 'A sale item may appear only once in a return request';
  END IF;

  SELECT * INTO _sale
  FROM public.sales
  WHERE id = _sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  IF NOT public.has_branch_role(
    _user_id,
    _sale.tenant_id,
    _sale.branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  _request_payload := jsonb_build_object(
    'sale_id', _sale_id,
    'items', _items,
    'reason_code', _normalized_reason_code,
    'reason', NULLIF(trim(COALESCE(_reason, '')), ''),
    'cash_session_id', _cash_session_id,
    'evidence_url', _evidence_url
  );

  SELECT * INTO _existing_return
  FROM public.sale_returns
  WHERE tenant_id = _sale.tenant_id
    AND client_mutation_id = _client_mutation_id
  FOR UPDATE;

  IF FOUND THEN
    IF _existing_return.request_payload IS DISTINCT FROM _request_payload THEN
      RAISE EXCEPTION 'Client mutation ID was already used for a different return request';
    END IF;
    IF _existing_return.status = 'completed' THEN
      RETURN _existing_return.id;
    END IF;
    RAISE EXCEPTION 'Return operation is already processing';
  END IF;

  IF _sale.channel IN ('pos','tables') THEN
    IF _cash_session_id IS NULL THEN
      RAISE EXCEPTION 'Return/refund must identify the exact open cash session';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.cash_sessions
      WHERE id = _cash_session_id
        AND tenant_id = _sale.tenant_id
        AND branch_id = _sale.branch_id
        AND status = 'open'
      FOR UPDATE
    ) THEN
      RAISE EXCEPTION 'The selected cash session is not open for this branch';
    END IF;
  ELSIF _cash_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'A cash session may only be attached to an in-person return/refund';
  END IF;

  IF _sale.status = 'refunded'::public.sale_status THEN
    RAISE EXCEPTION 'Sale is already fully refunded';
  END IF;
  IF _sale.status NOT IN ('completed'::public.sale_status, 'partially_refunded'::public.sale_status) THEN
    RAISE EXCEPTION 'Sale is not eligible for return/refund';
  END IF;

  SELECT COALESCE(sum(line_total_fils), 0)::bigint
  INTO _gross_items_fils
  FROM public.sale_items
  WHERE sale_id = _sale_id;

  _merchandise_pool_fils := _sale.total_fils - COALESCE(_sale.tip_amount_fils, 0);
  IF _gross_items_fils <= 0 OR _merchandise_pool_fils < 0 OR _merchandise_pool_fils > _gross_items_fils THEN
    RAISE EXCEPTION 'Sale merchandise totals are not refundable safely';
  END IF;

  SELECT COALESCE(sum(amount_fils), 0)::bigint
  INTO _prior_return_total_fils
  FROM public.sale_returns
  WHERE original_sale_id = _sale_id
    AND status = 'completed';

  IF _prior_return_total_fils > _merchandise_pool_fils THEN
    RAISE EXCEPTION 'Existing return history exceeds the refundable merchandise total';
  END IF;

  INSERT INTO public.sale_returns (
    tenant_id,
    branch_id,
    original_sale_id,
    reason_code,
    reason,
    amount,
    amount_fils,
    items,
    user_id,
    evidence_url,
    refund_method,
    status,
    client_mutation_id,
    request_payload,
    cash_session_id
  ) VALUES (
    _sale.tenant_id,
    _sale.branch_id,
    _sale_id,
    _normalized_reason_code,
    NULLIF(trim(COALESCE(_reason, '')), ''),
    0,
    0,
    _items,
    _user_id,
    _evidence_url,
    'original',
    'processing',
    _client_mutation_id,
    _request_payload,
    _cash_session_id
  )
  ON CONFLICT (tenant_id, client_mutation_id) WHERE client_mutation_id IS NOT NULL DO NOTHING
  RETURNING id INTO _return_id;

  IF _return_id IS NULL THEN
    SELECT * INTO _existing_return
    FROM public.sale_returns
    WHERE tenant_id = _sale.tenant_id
      AND client_mutation_id = _client_mutation_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Could not acquire return idempotency record';
    END IF;
    IF _existing_return.request_payload IS DISTINCT FROM _request_payload THEN
      RAISE EXCEPTION 'Client mutation ID was already used for a different return request';
    END IF;
    IF _existing_return.status = 'completed' THEN
      RETURN _existing_return.id;
    END IF;
    RAISE EXCEPTION 'Return operation is already processing';
  END IF;

  FOR _item IN SELECT value FROM jsonb_array_elements(_items) LOOP
    SELECT * INTO _sale_item
    FROM public.sale_items
    WHERE id = (_item->>'sale_item_id')::uuid
      AND sale_id = _sale_id
      AND tenant_id = _sale.tenant_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sale item does not belong to this sale';
    END IF;

    BEGIN
      _quantity := (_item->>'quantity')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Return quantity must be a valid number';
    END;

    IF _quantity IS NULL OR _quantity <= 0 OR _quantity <> round(_quantity, 3) THEN
      RAISE EXCEPTION 'Return quantity must be positive with at most three decimal places';
    END IF;

    SELECT
      COALESCE(sum(ri.quantity), 0),
      COALESCE(sum(ri.amount_fils), 0)::bigint
    INTO _already_quantity, _already_item_refund_fils
    FROM public.sale_return_items ri
    JOIN public.sale_returns r ON r.id = ri.return_id
    WHERE ri.sale_item_id = _sale_item.id
      AND r.status = 'completed';

    IF _already_quantity + _quantity > _sale_item.quantity THEN
      RAISE EXCEPTION 'Return exceeds remaining refundable quantity for sale item %', _sale_item.id;
    END IF;

    SELECT
      round(
        _merchandise_pool_fils::numeric
        * cumulative_line_fils::numeric
        / _gross_items_fils::numeric
      )::bigint
      - round(
        _merchandise_pool_fils::numeric
        * previous_line_fils::numeric
        / _gross_items_fils::numeric
      )::bigint
    INTO _item_pool_fils
    FROM (
      SELECT
        id,
        sum(line_total_fils) OVER (
          ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )::bigint AS cumulative_line_fils,
        COALESCE(sum(line_total_fils) OVER (
          ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0)::bigint AS previous_line_fils
      FROM public.sale_items
      WHERE sale_id = _sale_id
    ) allocation
    WHERE id = _sale_item.id;

    _target_item_refund_fils := round(
      _item_pool_fils::numeric
      * (_already_quantity + _quantity)
      / _sale_item.quantity
    )::bigint;
    _line_refund_fils := _target_item_refund_fils - _already_item_refund_fils;

    IF _line_refund_fils < 0 THEN
      RAISE EXCEPTION 'Return item refund history is inconsistent';
    END IF;

    INSERT INTO public.sale_return_items (
      tenant_id,
      branch_id,
      return_id,
      sale_item_id,
      product_id,
      quantity,
      amount,
      amount_fils
    ) VALUES (
      _sale.tenant_id,
      _sale.branch_id,
      _return_id,
      _sale_item.id,
      _sale_item.product_id,
      _quantity,
      public.fils_to_bhd_numeric(_line_refund_fils),
      _line_refund_fils
    )
    RETURNING id INTO _return_item_id;

    _return_total_fils := _return_total_fils + _line_refund_fils;

    IF _sale_item.product_id IS NOT NULL
       AND _sale_item.product_type IN ('simple','production','combo')
    THEN
      PERFORM public.apply_inventory_movement(
        _sale.tenant_id,
        _sale.branch_id,
        _sale_item.product_id,
        'return'::public.movement_type,
        _quantity,
        'Return/refund ' || _return_id::text,
        'sale_return_item',
        _return_item_id,
        _user_id,
        NULL
      );
    ELSIF _sale_item.product_type = 'composite'::public.product_type THEN
      RAISE EXCEPTION 'Composite returns require a historical component snapshot before stock can be reversed safely';
    END IF;
  END LOOP;

  _new_cumulative_return_fils := _prior_return_total_fils + _return_total_fils;
  IF _new_cumulative_return_fils > _merchandise_pool_fils THEN
    RAISE EXCEPTION 'Return exceeds remaining refundable value';
  END IF;

  SELECT COALESCE(sum(amount_fils), 0)::bigint
  INTO _original_payment_total_fils
  FROM public.payments
  WHERE sale_id = _sale_id;

  IF _original_payment_total_fils <> _sale.total_fils OR _sale.total_fils <= 0 THEN
    RAISE EXCEPTION 'Original payment allocations do not reconcile with the sale total';
  END IF;

  FOR _payment IN
    SELECT p.*
    FROM public.payments p
    WHERE p.sale_id = _sale_id
    ORDER BY p.id
  LOOP
    _payment_cumulative_fils := _payment_cumulative_fils + _payment.amount_fils;
    _payment_target_cumulative_fils := round(
      _new_cumulative_return_fils::numeric
      * _payment_cumulative_fils::numeric
      / _sale.total_fils::numeric
    )::bigint;
    _payment_target_fils := _payment_target_cumulative_fils - _previous_payment_target_fils;
    _previous_payment_target_fils := _payment_target_cumulative_fils;

    SELECT COALESCE(sum(pr.amount_fils), 0)::bigint
    INTO _already_payment_refunded_fils
    FROM public.payment_refunds pr
    JOIN public.sale_returns r ON r.id = pr.return_id
    WHERE pr.payment_id = _payment.id
      AND r.status = 'completed';

    _payment_refund_fils := _payment_target_fils - _already_payment_refunded_fils;
    IF _payment_refund_fils < 0 OR _already_payment_refunded_fils + _payment_refund_fils > _payment.amount_fils THEN
      RAISE EXCEPTION 'Payment refund history exceeds the original payment allocation';
    END IF;

    IF _payment_refund_fils > 0 THEN
      INSERT INTO public.payment_refunds (
        tenant_id,
        branch_id,
        return_id,
        payment_id,
        cash_session_id,
        method,
        amount,
        amount_fils
      ) VALUES (
        _sale.tenant_id,
        _sale.branch_id,
        _return_id,
        _payment.id,
        _cash_session_id,
        _payment.method,
        public.fils_to_bhd_numeric(_payment_refund_fils),
        _payment_refund_fils
      );

      IF _cash_session_id IS NOT NULL THEN
        UPDATE public.cash_sessions
        SET
          total_cash = public.fils_to_bhd_numeric(
            total_cash_fils - CASE WHEN _payment.method = 'cash' THEN _payment_refund_fils ELSE 0 END
          ),
          total_card = public.fils_to_bhd_numeric(
            total_card_fils - CASE WHEN _payment.method = 'card' THEN _payment_refund_fils ELSE 0 END
          ),
          total_transfer = public.fils_to_bhd_numeric(
            total_transfer_fils - CASE WHEN _payment.method = 'transfer' THEN _payment_refund_fils ELSE 0 END
          ),
          total_qr = public.fils_to_bhd_numeric(
            total_qr_fils - CASE WHEN _payment.method = 'qr' THEN _payment_refund_fils ELSE 0 END
          )
        WHERE id = _cash_session_id;
      END IF;

      _payment_refund_total_fils := _payment_refund_total_fils + _payment_refund_fils;
    END IF;
  END LOOP;

  IF _payment_refund_total_fils <> _return_total_fils THEN
    RAISE EXCEPTION 'Refund payment allocations do not exactly equal the return total';
  END IF;

  _resulting_status := CASE
    WHEN _new_cumulative_return_fils = _merchandise_pool_fils
      THEN 'refunded'::public.sale_status
    ELSE 'partially_refunded'::public.sale_status
  END;

  UPDATE public.sale_returns
  SET amount = public.fils_to_bhd_numeric(_return_total_fils),
      amount_fils = _return_total_fils,
      status = 'completed'
  WHERE id = _return_id;

  UPDATE public.sales
  SET status = _resulting_status
  WHERE id = _sale_id;

  INSERT INTO public.audit_logs (
    tenant_id,
    user_id,
    action,
    entity,
    entity_id,
    metadata
  ) VALUES (
    _sale.tenant_id,
    _user_id,
    'sale.returned_v2',
    'sale_returns',
    _return_id,
    jsonb_build_object(
      'operation_id', _client_mutation_id,
      'sale_id', _sale_id,
      'branch_id', _sale.branch_id,
      'cash_session_id', _cash_session_id,
      'reason_code', _normalized_reason_code,
      'amount_fils', _return_total_fils,
      'previous_sale_status', _sale.status::text,
      'resulting_sale_status', _resulting_status::text
    )
  );

  RETURN _return_id;
END;
$$;

REVOKE ALL ON FUNCTION public.process_sale_return_v2(uuid, jsonb, text, text, uuid, text, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_sale_return_v2(uuid, jsonb, text, text, uuid, text, text)
TO authenticated;

-- Disable the legacy return command when it exists. It uses 2-decimal refund
-- math and plaintext PIN comparison, so leaving it executable would create a
-- second, weaker financial path around v2.
DO $$
BEGIN
  IF to_regprocedure('public.process_sale_return(uuid,jsonb,text,text,text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.process_sale_return(uuid,jsonb,text,text,text,text) FROM PUBLIC, anon, authenticated';
  END IF;
END;
$$;

COMMIT;
