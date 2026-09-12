-- ZAIPOS P1: exact-money, server-authoritative in-house delivery registration.
-- Delivery metadata gets its own payload-bound idempotency record while the
-- existing checkout_sale_v2 remains the single authority for product price,
-- tax, sale, payment and inventory effects.

BEGIN;

ALTER TABLE public.delivery_orders
  ADD COLUMN IF NOT EXISTS delivery_fee_fils bigint;

UPDATE public.delivery_orders
SET delivery_fee_fils = public.bhd_numeric_to_fils(COALESCE(delivery_fee, 0))
WHERE delivery_fee_fils IS NULL;

ALTER TABLE public.delivery_orders
  ALTER COLUMN delivery_fee_fils SET DEFAULT 0,
  ALTER COLUMN delivery_fee_fils SET NOT NULL;

ALTER TABLE public.delivery_orders
  DROP CONSTRAINT IF EXISTS delivery_orders_delivery_fee_fils_nonnegative;
ALTER TABLE public.delivery_orders
  ADD CONSTRAINT delivery_orders_delivery_fee_fils_nonnegative
  CHECK (delivery_fee_fils >= 0);

CREATE TABLE IF NOT EXISTS public.delivery_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  client_mutation_id text NOT NULL,
  request_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed')),
  delivery_order_id uuid REFERENCES public.delivery_orders(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, client_mutation_id),
  CONSTRAINT delivery_operations_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id)
    ON DELETE RESTRICT,
  CHECK (length(trim(client_mutation_id)) >= 8),
  CHECK (
    (status = 'processing' AND delivery_order_id IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND delivery_order_id IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_delivery_operations_order
  ON public.delivery_operations(delivery_order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_operations_tenant_created
  ON public.delivery_operations(tenant_id, created_at DESC);

ALTER TABLE public.delivery_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_operations_admin_select ON public.delivery_operations;
CREATE POLICY delivery_operations_admin_select
ON public.delivery_operations
FOR SELECT TO authenticated
USING (
  public.has_any_role(
    auth.uid(), tenant_id, ARRAY['owner','admin','manager']::public.app_role[]
  )
);

REVOKE ALL ON public.delivery_operations FROM PUBLIC, anon;
GRANT SELECT ON public.delivery_operations TO authenticated;

CREATE OR REPLACE FUNCTION public.register_delivery_order_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _items jsonb,
  _address text,
  _delivery_fee_fils bigint,
  _client_mutation_id text,
  _customer_name text DEFAULT NULL,
  _customer_phone text DEFAULT NULL,
  _neighborhood text DEFAULT NULL,
  _customer_id uuid DEFAULT NULL,
  _notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _operation_id uuid;
  _operation public.delivery_operations;
  _request_payload jsonb;
  _sale_id uuid;
  _order_id uuid;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.has_branch_role(
    _user_id,
    _tenant_id,
    _branch_id,
    ARRAY['owner','admin','manager','cashier','waiter']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = _branch_id
      AND tenant_id = _tenant_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Branch is not active for this business';
  END IF;

  IF _items IS NULL OR jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Delivery must contain at least one item';
  END IF;

  _address := NULLIF(trim(COALESCE(_address, '')), '');
  IF _address IS NULL THEN
    RAISE EXCEPTION 'Delivery address is required';
  END IF;

  _delivery_fee_fils := COALESCE(_delivery_fee_fils, 0);
  IF _delivery_fee_fils < 0 THEN
    RAISE EXCEPTION 'Delivery fee cannot be negative';
  END IF;

  _client_mutation_id := NULLIF(trim(COALESCE(_client_mutation_id, '')), '');
  IF _client_mutation_id IS NULL OR length(_client_mutation_id) < 8 THEN
    RAISE EXCEPTION 'A stable client mutation ID is required for delivery registration';
  END IF;

  IF _customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customers
    WHERE id = _customer_id
      AND tenant_id = _tenant_id
  ) THEN
    RAISE EXCEPTION 'Customer does not belong to this business';
  END IF;

  _request_payload := jsonb_build_object(
    'tenant_id', _tenant_id,
    'branch_id', _branch_id,
    'items', _items,
    'address', _address,
    'delivery_fee_fils', _delivery_fee_fils,
    'customer_name', NULLIF(trim(COALESCE(_customer_name, '')), ''),
    'customer_phone', NULLIF(trim(COALESCE(_customer_phone, '')), ''),
    'neighborhood', NULLIF(trim(COALESCE(_neighborhood, '')), ''),
    'customer_id', _customer_id,
    'notes', NULLIF(trim(COALESCE(_notes, '')), '')
  );

  SELECT * INTO _operation
  FROM public.delivery_operations
  WHERE tenant_id = _tenant_id
    AND client_mutation_id = _client_mutation_id
  FOR UPDATE;

  IF FOUND THEN
    IF _operation.request_payload IS DISTINCT FROM _request_payload THEN
      RAISE EXCEPTION 'Client mutation ID was already used for a different delivery request';
    END IF;
    IF _operation.status = 'completed' AND _operation.delivery_order_id IS NOT NULL THEN
      RETURN _operation.delivery_order_id;
    END IF;
    RAISE EXCEPTION 'Delivery operation is already processing';
  END IF;

  INSERT INTO public.delivery_operations (
    tenant_id, branch_id, user_id, client_mutation_id, request_payload, status
  ) VALUES (
    _tenant_id, _branch_id, _user_id, _client_mutation_id, _request_payload, 'processing'
  )
  ON CONFLICT (tenant_id, client_mutation_id) DO NOTHING
  RETURNING id INTO _operation_id;

  IF _operation_id IS NULL THEN
    SELECT * INTO _operation
    FROM public.delivery_operations
    WHERE tenant_id = _tenant_id
      AND client_mutation_id = _client_mutation_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Could not acquire delivery idempotency record';
    END IF;
    IF _operation.request_payload IS DISTINCT FROM _request_payload THEN
      RAISE EXCEPTION 'Client mutation ID was already used for a different delivery request';
    END IF;
    IF _operation.status = 'completed' AND _operation.delivery_order_id IS NOT NULL THEN
      RETURN _operation.delivery_order_id;
    END IF;
    RAISE EXCEPTION 'Delivery operation is already processing';
  END IF;

  -- checkout_sale_v2 ignores client price/tax hints and resolves the active
  -- product/channel/branch authority in integer fils. Empty payments are valid
  -- for unpaid delivery orders; any supplied checkout payments would still be
  -- required to reconcile exactly by checkout_sale_v2 itself.
  _sale_id := public.checkout_sale_v2(
    _tenant_id,
    _branch_id,
    _items,
    '[]'::jsonb,
    0,
    NULLIF(trim(COALESCE(_notes, '')), ''),
    _customer_id,
    'delivery'::public.sales_channel,
    0,
    NULL,
    _client_mutation_id,
    NULL
  );

  INSERT INTO public.delivery_orders (
    tenant_id,
    branch_id,
    customer_id,
    customer_name,
    customer_phone,
    address,
    neighborhood,
    delivery_fee,
    delivery_fee_fils,
    status,
    notes,
    sale_id,
    user_id
  ) VALUES (
    _tenant_id,
    _branch_id,
    _customer_id,
    NULLIF(trim(COALESCE(_customer_name, '')), ''),
    NULLIF(trim(COALESCE(_customer_phone, '')), ''),
    _address,
    NULLIF(trim(COALESCE(_neighborhood, '')), ''),
    public.fils_to_bhd_numeric(_delivery_fee_fils),
    _delivery_fee_fils,
    'received',
    NULLIF(trim(COALESCE(_notes, '')), ''),
    _sale_id,
    _user_id
  )
  RETURNING id INTO _order_id;

  UPDATE public.delivery_operations
  SET status = 'completed',
      delivery_order_id = _order_id,
      completed_at = now()
  WHERE id = _operation_id;

  RETURN _order_id;
END;
$$;

-- The numeric, client-authoritative predecessor is no longer callable from a
-- logged-in application client. Keep the function only for historical schema
-- compatibility/service-role maintenance until full removal can be rehearsed.
REVOKE EXECUTE ON FUNCTION public.register_delivery_order(
  uuid, uuid, jsonb, text, text, text, text, numeric, uuid, text
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.register_delivery_order_v2(
  uuid, uuid, jsonb, text, bigint, text, text, text, text, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_delivery_order_v2(
  uuid, uuid, jsonb, text, bigint, text, text, text, text, uuid, text
) TO authenticated;

COMMIT;
