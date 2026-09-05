-- ZAIPOS P0.6: exact, idempotent sale void lifecycle.
--
-- A void is an in-session cancellation of an uncompensated completed sale.
-- Historical sale/payment/item rows remain immutable; the command records
-- compensating item/payment ledgers, reverses original till buckets exactly,
-- restores inventory once, restores coupon usage once, and fails closed when
-- a customer-linked sale lacks durable loyalty-award evidence.

BEGIN;

CREATE TABLE public.sale_voids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  cash_session_id uuid REFERENCES public.cash_sessions(id) ON DELETE RESTRICT,
  client_mutation_id text NOT NULL,
  request_payload jsonb NOT NULL,
  reason text,
  total numeric(14,3) NOT NULL,
  total_fils bigint NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  coupon_code text,
  coupon_restored boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT sale_voids_total_nonnegative CHECK (total_fils >= 0),
  CONSTRAINT sale_voids_total_parity CHECK (
    total_fils = public.bhd_numeric_to_fils(total)
  ),
  CONSTRAINT sale_voids_operation_id CHECK (
    length(trim(client_mutation_id)) >= 8
  ),
  CONSTRAINT sale_voids_status CHECK (status IN ('processing', 'completed')),
  UNIQUE(sale_id),
  UNIQUE(tenant_id, client_mutation_id)
);

CREATE INDEX idx_sale_voids_branch_created
  ON public.sale_voids(tenant_id, branch_id, created_at);

CREATE TRIGGER sync_sale_voids_fils
BEFORE INSERT OR UPDATE ON public.sale_voids
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"total":"total_fils"}'
);

CREATE TABLE public.sale_void_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  void_id uuid NOT NULL REFERENCES public.sale_voids(id) ON DELETE RESTRICT,
  sale_item_id uuid NOT NULL REFERENCES public.sale_items(id) ON DELETE RESTRICT,
  product_id uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  quantity numeric(12,3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sale_void_items_quantity_positive CHECK (
    quantity > 0 AND quantity = round(quantity, 3)
  ),
  UNIQUE(void_id, sale_item_id)
);

CREATE INDEX idx_sale_void_items_sale_item
  ON public.sale_void_items(sale_item_id);

CREATE TABLE public.payment_voids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  void_id uuid NOT NULL REFERENCES public.sale_voids(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  cash_session_id uuid REFERENCES public.cash_sessions(id) ON DELETE RESTRICT,
  method public.payment_method NOT NULL,
  amount numeric(14,3) NOT NULL,
  amount_fils bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_voids_amount_positive CHECK (amount_fils > 0),
  CONSTRAINT payment_voids_amount_parity CHECK (
    amount_fils = public.bhd_numeric_to_fils(amount)
  ),
  UNIQUE(void_id, payment_id)
);

CREATE INDEX idx_payment_voids_payment
  ON public.payment_voids(payment_id, created_at);

CREATE TRIGGER sync_payment_voids_fils
BEFORE INSERT OR UPDATE ON public.payment_voids
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"amount":"amount_fils"}'
);

ALTER TABLE public.sale_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_void_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_voids ENABLE ROW LEVEL SECURITY;

CREATE POLICY sale_voids_branch_select_v2
ON public.sale_voids
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

CREATE POLICY sale_void_items_branch_select_v2
ON public.sale_void_items
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

CREATE POLICY payment_voids_branch_select_v2
ON public.payment_voids
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

REVOKE ALL ON public.sale_voids FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sale_void_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payment_voids FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sale_voids TO authenticated;
GRANT SELECT ON public.sale_void_items TO authenticated;
GRANT SELECT ON public.payment_voids TO authenticated;

-- Every inventory effect is keyed by the immutable void-item row. Replays or
-- accidental duplicate calls cannot restore the same sold line twice.
CREATE UNIQUE INDEX uq_inventory_void_item_effect
  ON public.inventory_movements(tenant_id, reference_type, reference_id, movement_type)
  WHERE reference_type = 'sale_void_item'
    AND movement_type = 'return'::public.movement_type;

CREATE OR REPLACE FUNCTION public.process_sale_void_v2(
  _sale_id uuid,
  _client_mutation_id text,
  _cash_session_id uuid DEFAULT NULL,
  _reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _sale public.sales;
  _existing_void public.sale_voids;
  _void_id uuid;
  _request_payload jsonb;
  _normalized_reason text;
  _item public.sale_items;
  _void_item_id uuid;
  _payment public.payments;
  _payment_total_fils bigint := 0;
  _payment_count integer := 0;
  _session public.cash_sessions;
  _coupon_id uuid;
  _coupon_current_uses integer;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  _client_mutation_id := NULLIF(trim(COALESCE(_client_mutation_id, '')), '');
  IF _client_mutation_id IS NULL OR length(_client_mutation_id) < 8 THEN
    RAISE EXCEPTION 'A stable client mutation ID is required for sale void';
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

  _normalized_reason := NULLIF(trim(COALESCE(_reason, '')), '');
  _request_payload := jsonb_build_object(
    'sale_id', _sale_id,
    'cash_session_id', _cash_session_id,
    'reason', _normalized_reason
  );

  SELECT * INTO _existing_void
  FROM public.sale_voids
  WHERE tenant_id = _sale.tenant_id
    AND client_mutation_id = _client_mutation_id;

  IF FOUND THEN
    IF _existing_void.request_payload IS DISTINCT FROM _request_payload THEN
      RAISE EXCEPTION 'Operation ID was already used for a different void request';
    END IF;
    IF _existing_void.status = 'completed' THEN
      RETURN _existing_void.id;
    END IF;
    RAISE EXCEPTION 'Sale void operation is already processing';
  END IF;

  SELECT * INTO _existing_void
  FROM public.sale_voids
  WHERE sale_id = _sale_id;

  IF FOUND THEN
    RAISE EXCEPTION 'Sale is already voided';
  END IF;

  IF _sale.status <> 'completed'::public.sale_status OR EXISTS (
    SELECT 1
    FROM public.sale_returns
    WHERE original_sale_id = _sale_id
      AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'Void requires a completed uncompensated sale';
  END IF;

  -- Checkout currently mutates customer.loyalty_points without persisting the
  -- awarded delta on the sale. Recomputing it from today's tenant settings
  -- would fabricate reversal evidence, so customer-linked voids fail closed
  -- until the dedicated loyalty-ledger phase records the exact award.
  IF _sale.customer_id IS NOT NULL THEN
    RAISE EXCEPTION 'Customer-linked sale void requires loyalty reversal evidence';
  END IF;

  -- Composite checkout consumes recipe components, but historical component
  -- quantities are not snapshotted on sale_items. Current recipes cannot be
  -- used as reversal evidence because recipes may have changed after sale.
  IF EXISTS (
    SELECT 1 FROM public.sale_items
    WHERE sale_id = _sale_id
      AND product_type = 'composite'::public.product_type
  ) THEN
    RAISE EXCEPTION 'Composite sale void requires historical component snapshot evidence';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sale_items
    WHERE sale_id = _sale_id
      AND product_type IN (
        'simple'::public.product_type,
        'production'::public.product_type,
        'combo'::public.product_type
      )
      AND product_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Sale item is missing product evidence required for stock reversal';
  END IF;

  IF _sale.channel IN ('pos'::public.sales_channel, 'tables'::public.sales_channel) THEN
    IF _sale.session_id IS NULL OR _cash_session_id IS NULL OR _cash_session_id <> _sale.session_id THEN
      RAISE EXCEPTION 'Void must use the original cash session for an in-person sale';
    END IF;

    SELECT * INTO _session
    FROM public.cash_sessions
    WHERE id = _sale.session_id
      AND tenant_id = _sale.tenant_id
      AND branch_id = _sale.branch_id
      AND status = 'open'
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Void requires the open original cash session';
    END IF;
  ELSIF _cash_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'A cash session may only be attached to an in-person sale void';
  END IF;

  SELECT COALESCE(sum(amount_fils), 0), count(*)
  INTO _payment_total_fils, _payment_count
  FROM public.payments
  WHERE sale_id = _sale_id
    AND tenant_id = _sale.tenant_id;

  IF (_sale.channel IN ('pos'::public.sales_channel, 'tables'::public.sales_channel) OR _payment_count > 0)
     AND _payment_total_fils <> _sale.total_fils THEN
    RAISE EXCEPTION 'Original payments do not reconcile to the committed sale total';
  END IF;

  IF NULLIF(trim(COALESCE(_sale.coupon_code, '')), '') IS NOT NULL THEN
    SELECT id, current_uses
    INTO _coupon_id, _coupon_current_uses
    FROM public.discount_codes
    WHERE tenant_id = _sale.tenant_id
      AND upper(code) = upper(trim(_sale.coupon_code))
    FOR UPDATE;

    IF NOT FOUND OR COALESCE(_coupon_current_uses, 0) <= 0 THEN
      RAISE EXCEPTION 'Original coupon usage evidence is unavailable for safe void';
    END IF;
  END IF;

  INSERT INTO public.sale_voids (
    tenant_id,
    branch_id,
    sale_id,
    user_id,
    cash_session_id,
    client_mutation_id,
    request_payload,
    reason,
    total,
    status,
    coupon_code
  ) VALUES (
    _sale.tenant_id,
    _sale.branch_id,
    _sale_id,
    _user_id,
    CASE WHEN _sale.channel IN ('pos'::public.sales_channel, 'tables'::public.sales_channel)
      THEN _sale.session_id ELSE NULL END,
    _client_mutation_id,
    _request_payload,
    _normalized_reason,
    public.fils_to_bhd_numeric(_sale.total_fils),
    'processing',
    NULLIF(trim(COALESCE(_sale.coupon_code, '')), '')
  ) RETURNING id INTO _void_id;

  FOR _item IN
    SELECT * FROM public.sale_items
    WHERE sale_id = _sale_id
    ORDER BY id
  LOOP
    INSERT INTO public.sale_void_items (
      tenant_id,
      branch_id,
      void_id,
      sale_item_id,
      product_id,
      quantity
    ) VALUES (
      _sale.tenant_id,
      _sale.branch_id,
      _void_id,
      _item.id,
      _item.product_id,
      _item.quantity
    ) RETURNING id INTO _void_item_id;

    IF _item.product_type IN (
      'simple'::public.product_type,
      'production'::public.product_type,
      'combo'::public.product_type
    ) THEN
      PERFORM public.apply_inventory_movement(
        _sale.tenant_id,
        _sale.branch_id,
        _item.product_id,
        'return'::public.movement_type,
        _item.quantity,
        'Sale void',
        'sale_void_item',
        _void_item_id,
        _user_id,
        NULL
      );
    END IF;
  END LOOP;

  FOR _payment IN
    SELECT * FROM public.payments
    WHERE sale_id = _sale_id
      AND tenant_id = _sale.tenant_id
    ORDER BY id
  LOOP
    INSERT INTO public.payment_voids (
      tenant_id,
      branch_id,
      void_id,
      payment_id,
      cash_session_id,
      method,
      amount
    ) VALUES (
      _sale.tenant_id,
      _sale.branch_id,
      _void_id,
      _payment.id,
      CASE WHEN _sale.channel IN ('pos'::public.sales_channel, 'tables'::public.sales_channel)
        THEN _sale.session_id ELSE NULL END,
      _payment.method,
      public.fils_to_bhd_numeric(_payment.amount_fils)
    );

    IF _sale.channel IN ('pos'::public.sales_channel, 'tables'::public.sales_channel) THEN
      UPDATE public.cash_sessions
      SET total_cash = total_cash - CASE
            WHEN _payment.method = 'cash'::public.payment_method
              THEN public.fils_to_bhd_numeric(_payment.amount_fils) ELSE 0 END,
          total_card = total_card - CASE
            WHEN _payment.method = 'card'::public.payment_method
              THEN public.fils_to_bhd_numeric(_payment.amount_fils) ELSE 0 END,
          total_transfer = total_transfer - CASE
            WHEN _payment.method = 'transfer'::public.payment_method
              THEN public.fils_to_bhd_numeric(_payment.amount_fils) ELSE 0 END,
          total_qr = total_qr - CASE
            WHEN _payment.method = 'qr'::public.payment_method
              THEN public.fils_to_bhd_numeric(_payment.amount_fils) ELSE 0 END
      WHERE id = _sale.session_id;
    END IF;
  END LOOP;

  IF _coupon_id IS NOT NULL THEN
    UPDATE public.discount_codes
    SET current_uses = current_uses - 1
    WHERE id = _coupon_id;

    UPDATE public.sale_voids
    SET coupon_restored = true
    WHERE id = _void_id;
  END IF;

  UPDATE public.sales
  SET status = 'cancelled'::public.sale_status
  WHERE id = _sale_id;

  UPDATE public.sale_voids
  SET status = 'completed',
      completed_at = now()
  WHERE id = _void_id;

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
    'sale.voided_v2',
    'sales',
    _sale_id,
    jsonb_build_object(
      'void_id', _void_id,
      'branch_id', _sale.branch_id,
      'cash_session_id', CASE WHEN _sale.channel IN ('pos'::public.sales_channel, 'tables'::public.sales_channel)
        THEN _sale.session_id ELSE NULL END,
      'total_fils', _sale.total_fils,
      'payment_fils', _payment_total_fils,
      'coupon_restored', _coupon_id IS NOT NULL,
      'client_mutation_id', _client_mutation_id
    )
  );

  RETURN _void_id;
END;
$$;

REVOKE ALL ON FUNCTION public.process_sale_void_v2(uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_sale_void_v2(uuid, text, uuid, text)
  TO authenticated;

COMMENT ON FUNCTION public.process_sale_void_v2(uuid, text, uuid, text) IS
  'P0.6 exact sale void. Cancels only an uncompensated completed sale, binds in-person cancellation to the still-open original cash session, records compensating stock/payment ledgers, restores coupon usage, and enforces replay-safe manager authorization.';

COMMIT;
