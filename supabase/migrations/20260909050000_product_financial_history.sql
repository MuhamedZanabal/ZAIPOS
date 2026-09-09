-- Canonical selling-price and received-cost history with immutable sale COGS.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.purchase_order_items'::regclass
      AND conname = 'purchase_order_items_tenant_id_id_key'
  ) THEN
    ALTER TABLE public.purchase_order_items
      ADD CONSTRAINT purchase_order_items_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.suppliers'::regclass
      AND conname = 'suppliers_tenant_id_id_key'
  ) THEN
    ALTER TABLE public.suppliers
      ADD CONSTRAINT suppliers_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.purchase_orders'::regclass
      AND conname = 'purchase_orders_tenant_id_id_key'
  ) THEN
    ALTER TABLE public.purchase_orders
      ADD CONSTRAINT purchase_orders_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END
$$;

ALTER TABLE public.purchase_order_items
  ADD COLUMN cost_price_fils bigint,
  ADD COLUMN line_total_fils bigint;

UPDATE public.purchase_order_items
SET cost_price_fils = public.bhd_numeric_to_fils(cost_price),
    line_total_fils = public.bhd_numeric_to_fils(line_total);

ALTER TABLE public.purchase_order_items
  ALTER COLUMN cost_price_fils SET NOT NULL,
  ALTER COLUMN line_total_fils SET NOT NULL,
  ADD CONSTRAINT purchase_order_items_cost_fils_nonnegative CHECK (cost_price_fils >= 0 AND line_total_fils >= 0),
  ADD CONSTRAINT purchase_order_items_cost_fils_parity CHECK (
    cost_price_fils = public.bhd_numeric_to_fils(cost_price)
    AND line_total_fils = public.bhd_numeric_to_fils(line_total)
  );

CREATE TRIGGER sync_purchase_order_items_fils
BEFORE INSERT OR UPDATE ON public.purchase_order_items
FOR EACH ROW EXECUTE FUNCTION public.sync_fils_columns_from_numeric(
  '{"cost_price":"cost_price_fils","line_total":"line_total_fils"}'
);

CREATE TABLE public.product_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  branch_id uuid,
  channel public.sales_channel,
  price_type text NOT NULL CHECK (price_type IN ('selling','cost')),
  amount_fils bigint NOT NULL CHECK (amount_fils >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  source text NOT NULL CHECK (source IN ('initial','manual','purchase_receipt','compatibility','legacy_backfill')),
  supplier_id uuid,
  purchase_order_id uuid,
  purchase_order_item_id uuid,
  operation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_prices_tenant_product_fkey
    FOREIGN KEY (tenant_id, product_id) REFERENCES public.products(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT product_prices_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id) REFERENCES public.branches(tenant_id, id),
  CONSTRAINT product_prices_tenant_purchase_item_fkey
    FOREIGN KEY (tenant_id, purchase_order_item_id)
    REFERENCES public.purchase_order_items(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT product_prices_tenant_supplier_fkey
    FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES public.suppliers(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT product_prices_tenant_purchase_order_fkey
    FOREIGN KEY (tenant_id, purchase_order_id)
    REFERENCES public.purchase_orders(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT product_prices_interval_check
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT product_prices_scope_check CHECK (
    (price_type = 'selling' AND supplier_id IS NULL AND purchase_order_id IS NULL AND purchase_order_item_id IS NULL)
    OR (price_type = 'cost' AND channel IS NULL)
  ),
  CONSTRAINT product_prices_purchase_source_check CHECK (
    source <> 'purchase_receipt'
    OR (price_type = 'cost' AND branch_id IS NOT NULL AND purchase_order_id IS NOT NULL AND purchase_order_item_id IS NOT NULL)
  ),
  CONSTRAINT product_prices_operation_id_check
    CHECK (operation_id IS NULL OR length(btrim(operation_id)) >= 8)
);

CREATE UNIQUE INDEX product_prices_current_base_key
ON public.product_prices(tenant_id, product_id, price_type)
WHERE effective_to IS NULL AND branch_id IS NULL AND channel IS NULL;

CREATE UNIQUE INDEX product_prices_current_branch_key
ON public.product_prices(tenant_id, product_id, price_type, branch_id)
WHERE effective_to IS NULL AND branch_id IS NOT NULL AND channel IS NULL;

CREATE UNIQUE INDEX product_prices_current_global_channel_key
ON public.product_prices(tenant_id, product_id, price_type, channel)
WHERE effective_to IS NULL AND branch_id IS NULL AND channel IS NOT NULL;

CREATE UNIQUE INDEX product_prices_current_branch_channel_key
ON public.product_prices(tenant_id, product_id, price_type, branch_id, channel)
WHERE effective_to IS NULL AND branch_id IS NOT NULL AND channel IS NOT NULL;

CREATE UNIQUE INDEX product_prices_purchase_item_key
ON public.product_prices(purchase_order_item_id)
WHERE purchase_order_item_id IS NOT NULL;

CREATE INDEX product_prices_product_timeline_idx
ON public.product_prices(tenant_id, product_id, price_type, effective_from DESC);

CREATE INDEX product_prices_context_lookup_idx
ON public.product_prices(tenant_id, product_id, branch_id, channel, price_type, effective_from DESC)
WHERE effective_to IS NULL;

CREATE TABLE public.product_financial_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  operation_id text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('base_financials','selling_price')),
  request_hash text NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_financial_operations_tenant_product_fkey
    FOREIGN KEY (tenant_id, product_id) REFERENCES public.products(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT product_financial_operations_id_check CHECK (length(btrim(operation_id)) >= 8),
  CONSTRAINT product_financial_operations_tenant_operation_key UNIQUE (tenant_id, operation_id)
);

CREATE INDEX product_financial_operations_product_idx
ON public.product_financial_operations(tenant_id, product_id, created_at DESC);

ALTER TABLE public.product_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_financial_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_prices_catalogue_read ON public.product_prices
FOR SELECT TO authenticated
USING (public.has_any_role(
  auth.uid(), tenant_id,
  ARRAY['owner','admin','manager','inventory']::public.app_role[]
));

REVOKE ALL ON public.product_prices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.product_prices TO authenticated;
REVOKE ALL ON public.product_financial_operations FROM PUBLIC, anon, authenticated;

-- Preserve the authoritative values present at migration time.
INSERT INTO public.product_prices(
  tenant_id, product_id, price_type, amount_fils, effective_from, reason, source
)
SELECT tenant_id, id, 'selling', price_fils, created_at,
  'Initial selling price preserved during ledger migration', 'legacy_backfill'
FROM public.products;

INSERT INTO public.product_prices(
  tenant_id, product_id, price_type, amount_fils, effective_from, reason, source
)
SELECT tenant_id, id, 'cost', cost_fils, created_at,
  'Initial product cost preserved during ledger migration', 'legacy_backfill'
FROM public.products;

INSERT INTO public.product_prices(
  tenant_id, product_id, branch_id, price_type, amount_fils, effective_from, reason, source
)
SELECT tenant_id, product_id, branch_id, 'selling', local_price_fils, created_at,
  'Branch selling price preserved during ledger migration', 'legacy_backfill'
FROM public.branch_products
WHERE local_price_fils IS NOT NULL;

INSERT INTO public.product_prices(
  tenant_id, product_id, branch_id, channel, price_type, amount_fils,
  effective_from, reason, source
)
SELECT tenant_id, product_id, branch_id, channel, 'selling', price_fils, created_at,
  'Channel selling price preserved during ledger migration', 'legacy_backfill'
FROM public.product_channel_prices;

WITH received_costs AS (
  SELECT item.tenant_id, item.product_id, purchase.branch_id, purchase.supplier_id,
    purchase.id AS purchase_order_id, item.id AS purchase_order_item_id,
    item.cost_price_fils AS amount_fils,
    COALESCE(purchase.received_at, purchase.updated_at, purchase.created_at) AS effective_from,
    lead(COALESCE(purchase.received_at, purchase.updated_at, purchase.created_at)) OVER (
      PARTITION BY item.tenant_id, item.product_id, purchase.branch_id
      ORDER BY COALESCE(purchase.received_at, purchase.updated_at, purchase.created_at), item.id
    ) AS effective_to
  FROM public.purchase_order_items item
  JOIN public.purchase_orders purchase
    ON purchase.id = item.order_id AND purchase.tenant_id = item.tenant_id
  WHERE purchase.status = 'received' AND item.product_id IS NOT NULL
)
INSERT INTO public.product_prices(
  tenant_id, product_id, branch_id, price_type, amount_fils,
  effective_from, effective_to, reason, source, supplier_id,
  purchase_order_id, purchase_order_item_id
)
SELECT tenant_id, product_id, branch_id, 'cost', amount_fils,
  effective_from, effective_to,
  'Historical received supplier cost preserved during ledger migration',
  'purchase_receipt', supplier_id, purchase_order_id, purchase_order_item_id
FROM received_costs;

CREATE OR REPLACE FUNCTION public.record_product_price_event_internal_v1(
  _tenant_id uuid,
  _product_id uuid,
  _price_type text,
  _amount_fils bigint,
  _branch_id uuid,
  _channel public.sales_channel,
  _actor_id uuid,
  _reason text,
  _source text,
  _operation_id text,
  _supplier_id uuid DEFAULT NULL,
  _purchase_order_id uuid DEFAULT NULL,
  _purchase_order_item_id uuid DEFAULT NULL,
  _effective_from timestamptz DEFAULT now(),
  _force_event boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _current public.product_prices;
  _new_id uuid;
BEGIN
  IF _price_type NOT IN ('selling','cost') OR _amount_fils IS NULL OR _amount_fils < 0 THEN
    RAISE EXCEPTION 'A valid exact-fils price event is required';
  END IF;

  PERFORM 1 FROM public.products
  WHERE tenant_id = _tenant_id AND id = _product_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product does not belong to this tenant'; END IF;

  SELECT * INTO _current
  FROM public.product_prices
  WHERE tenant_id = _tenant_id AND product_id = _product_id
    AND price_type = _price_type
    AND branch_id IS NOT DISTINCT FROM _branch_id
    AND channel IS NOT DISTINCT FROM _channel
    AND effective_to IS NULL
  FOR UPDATE;

  IF _current.id IS NOT NULL AND _current.amount_fils = _amount_fils AND NOT _force_event THEN
    RETURN _current.id;
  END IF;

  IF _current.id IS NOT NULL THEN
    UPDATE public.product_prices
    SET effective_to = GREATEST(_effective_from, _current.effective_from)
    WHERE id = _current.id;
  END IF;

  INSERT INTO public.product_prices(
    tenant_id, product_id, branch_id, channel, price_type, amount_fils,
    effective_from, changed_by, reason, source, supplier_id,
    purchase_order_id, purchase_order_item_id, operation_id
  ) VALUES (
    _tenant_id, _product_id, _branch_id, _channel, _price_type, _amount_fils,
    _effective_from, _actor_id, btrim(_reason), _source, _supplier_id,
    _purchase_order_id, _purchase_order_item_id, _operation_id
  ) RETURNING id INTO _new_id;
  RETURN _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.record_product_price_event_internal_v1(
  uuid,uuid,text,bigint,uuid,public.sales_channel,uuid,text,text,text,
  uuid,uuid,uuid,timestamptz,boolean
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_product_financial_direct_write_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
    AND COALESCE(current_setting('zaipos.product_financial_command', true), '') <> 'on'
    AND (NEW.price IS DISTINCT FROM OLD.price OR NEW.cost IS DISTINCT FROM OLD.cost
      OR NEW.price_fils IS DISTINCT FROM OLD.price_fils OR NEW.cost_fils IS DISTINCT FROM OLD.cost_fils)
  THEN
    RAISE EXCEPTION 'Product financial changes must use an authoritative financial command';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.guard_product_financial_direct_write_v1() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER products_financial_write_guard
BEFORE UPDATE OF price, cost, price_fils, cost_fils ON public.products
FOR EACH ROW EXECUTE FUNCTION public.guard_product_financial_direct_write_v1();

CREATE OR REPLACE FUNCTION public.capture_product_financial_compatibility_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(current_setting('zaipos.product_financial_command', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.record_product_price_event_internal_v1(
      NEW.tenant_id, NEW.id, 'selling', NEW.price_fils, NULL, NULL, auth.uid(),
      'Initial product selling price', 'initial', NULL
    );
    PERFORM public.record_product_price_event_internal_v1(
      NEW.tenant_id, NEW.id, 'cost', NEW.cost_fils, NULL, NULL, auth.uid(),
      'Initial product cost', 'initial', NULL
    );
  ELSE
    IF NEW.price_fils IS DISTINCT FROM OLD.price_fils THEN
      PERFORM public.record_product_price_event_internal_v1(
        NEW.tenant_id, NEW.id, 'selling', NEW.price_fils, NULL, NULL, auth.uid(),
        'Compatibility selling-price write captured automatically', 'compatibility', NULL
      );
    END IF;
    IF NEW.cost_fils IS DISTINCT FROM OLD.cost_fils THEN
      PERFORM public.record_product_price_event_internal_v1(
        NEW.tenant_id, NEW.id, 'cost', NEW.cost_fils, NULL, NULL, auth.uid(),
        'Compatibility cost write captured automatically', 'compatibility', NULL
      );
    END IF;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.capture_product_financial_compatibility_v1() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER products_financial_insert_capture
AFTER INSERT ON public.products
FOR EACH ROW EXECUTE FUNCTION public.capture_product_financial_compatibility_v1();

CREATE TRIGGER products_financial_update_capture
AFTER UPDATE OF price, cost, price_fils, cost_fils ON public.products
FOR EACH ROW EXECUTE FUNCTION public.capture_product_financial_compatibility_v1();

CREATE OR REPLACE FUNCTION public.claim_product_financial_operation_internal_v1(
  _tenant_id uuid,
  _product_id uuid,
  _operation_id text,
  _operation_kind text,
  _request_hash text,
  _actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _inserted integer;
  _existing public.product_financial_operations;
BEGIN
  INSERT INTO public.product_financial_operations(
    tenant_id, product_id, operation_id, operation_kind, request_hash, actor_id
  ) VALUES (_tenant_id, _product_id, _operation_id, _operation_kind, _request_hash, _actor_id)
  ON CONFLICT (tenant_id, operation_id) DO NOTHING;
  GET DIAGNOSTICS _inserted = ROW_COUNT;
  IF _inserted = 1 THEN RETURN false; END IF;

  SELECT * INTO _existing
  FROM public.product_financial_operations
  WHERE tenant_id = _tenant_id AND operation_id = _operation_id
  FOR UPDATE;
  IF _existing.product_id <> _product_id OR _existing.operation_kind <> _operation_kind
    OR _existing.request_hash <> _request_hash THEN
    RAISE EXCEPTION 'Financial operation ID was already used with different input';
  END IF;
  IF _existing.completed_at IS NULL THEN RAISE EXCEPTION 'Financial operation did not complete'; END IF;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.claim_product_financial_operation_internal_v1(uuid,uuid,text,text,text,uuid)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_product_base_financials_v1(
  _tenant_id uuid,
  _product_id uuid,
  _selling_amount_fils bigint,
  _cost_amount_fils bigint,
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
  _request_hash text;
  _replay boolean;
  _product public.products;
  _previous_setting text;
BEGIN
  IF NOT public.has_any_role(_actor_id, _tenant_id, ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Product financial change is forbidden';
  END IF;
  IF _selling_amount_fils IS NULL OR _selling_amount_fils < 0 OR _cost_amount_fils IS NULL OR _cost_amount_fils < 0 THEN
    RAISE EXCEPTION 'Selling price and cost must be nonnegative exact-fils values';
  END IF;
  _reason := btrim(COALESCE(_reason, ''));
  _operation_id := btrim(COALESCE(_operation_id, ''));
  IF length(_reason) < 3 THEN RAISE EXCEPTION 'A financial change reason is required'; END IF;
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'A stable financial operation ID is required'; END IF;

  SELECT * INTO _product FROM public.products
  WHERE tenant_id = _tenant_id AND id = _product_id FOR UPDATE;
  IF _product.id IS NULL THEN RAISE EXCEPTION 'Product does not belong to this tenant'; END IF;

  _request_hash := md5(jsonb_build_object(
    'product_id',_product_id,'selling_amount_fils',_selling_amount_fils,
    'cost_amount_fils',_cost_amount_fils,'reason',_reason
  )::text);
  _replay := public.claim_product_financial_operation_internal_v1(
    _tenant_id,_product_id,_operation_id,'base_financials',_request_hash,_actor_id
  );
  IF _replay THEN RETURN _product_id; END IF;

  PERFORM public.record_product_price_event_internal_v1(
    _tenant_id,_product_id,'selling',_selling_amount_fils,NULL,NULL,
    _actor_id,_reason,'manual',_operation_id
  );
  PERFORM public.record_product_price_event_internal_v1(
    _tenant_id,_product_id,'cost',_cost_amount_fils,NULL,NULL,
    _actor_id,_reason,'manual',_operation_id
  );

  _previous_setting := COALESCE(current_setting('zaipos.product_financial_command', true), '');
  PERFORM set_config('zaipos.product_financial_command', 'on', true);
  UPDATE public.products
  SET price = public.fils_to_bhd_numeric(_selling_amount_fils),
      cost = public.fils_to_bhd_numeric(_cost_amount_fils)
  WHERE tenant_id = _tenant_id AND id = _product_id;
  PERFORM set_config('zaipos.product_financial_command', _previous_setting, true);

  UPDATE public.product_financial_operations SET completed_at = now()
  WHERE tenant_id = _tenant_id AND operation_id = _operation_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (_tenant_id,_actor_id,'catalogue.product_financials_changed','product',_product_id,
    jsonb_build_object(
      'operation_id',_operation_id,'reason',_reason,
      'previous_selling_amount_fils',_product.price_fils,
      'selling_amount_fils',_selling_amount_fils,
      'previous_cost_amount_fils',_product.cost_fils,
      'cost_amount_fils',_cost_amount_fils
    ));
  RETURN _product_id;
END
$$;

REVOKE ALL ON FUNCTION public.set_product_base_financials_v1(uuid,uuid,bigint,bigint,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_product_base_financials_v1(uuid,uuid,bigint,bigint,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.set_product_selling_price_v1(
  _tenant_id uuid,
  _product_id uuid,
  _branch_id uuid,
  _channel public.sales_channel,
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
  _request_hash text;
  _replay boolean;
  _previous_setting text;
  _current public.product_prices;
BEGIN
  IF NOT public.has_any_role(_actor_id, _tenant_id, ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Selling-price change is forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE tenant_id=_tenant_id AND id=_product_id) THEN
    RAISE EXCEPTION 'Product does not belong to this tenant';
  END IF;
  IF _branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches WHERE tenant_id=_tenant_id AND id=_branch_id
  ) THEN RAISE EXCEPTION 'Branch does not belong to this tenant'; END IF;
  IF _amount_fils IS NULL AND _branch_id IS NULL AND _channel IS NULL THEN
    RAISE EXCEPTION 'The base selling price cannot be removed';
  END IF;
  IF _amount_fils IS NOT NULL AND _amount_fils < 0 THEN RAISE EXCEPTION 'Selling price cannot be negative'; END IF;
  _reason := btrim(COALESCE(_reason, ''));
  _operation_id := btrim(COALESCE(_operation_id, ''));
  IF length(_reason) < 3 THEN RAISE EXCEPTION 'A selling-price change reason is required'; END IF;
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'A stable selling-price operation ID is required'; END IF;

  PERFORM 1 FROM public.products
  WHERE tenant_id=_tenant_id AND id=_product_id
  FOR UPDATE;

  _request_hash := md5(jsonb_build_object(
    'product_id',_product_id,'branch_id',_branch_id,'channel',_channel,
    'amount_fils',_amount_fils,'reason',_reason
  )::text);
  _replay := public.claim_product_financial_operation_internal_v1(
    _tenant_id,_product_id,_operation_id,'selling_price',_request_hash,_actor_id
  );
  IF _replay THEN RETURN _product_id; END IF;

  SELECT * INTO _current FROM public.product_prices
  WHERE tenant_id=_tenant_id AND product_id=_product_id AND price_type='selling'
    AND branch_id IS NOT DISTINCT FROM _branch_id
    AND channel IS NOT DISTINCT FROM _channel
    AND effective_to IS NULL
  FOR UPDATE;

  IF _amount_fils IS NULL THEN
    UPDATE public.product_prices SET effective_to=now() WHERE id=_current.id;
  ELSE
    PERFORM public.record_product_price_event_internal_v1(
      _tenant_id,_product_id,'selling',_amount_fils,_branch_id,_channel,
      _actor_id,_reason,'manual',_operation_id
    );
  END IF;

  _previous_setting := COALESCE(current_setting('zaipos.product_financial_command', true), '');
  PERFORM set_config('zaipos.product_financial_command', 'on', true);
  IF _branch_id IS NULL AND _channel IS NULL THEN
    UPDATE public.products SET price=public.fils_to_bhd_numeric(_amount_fils)
    WHERE tenant_id=_tenant_id AND id=_product_id;
  ELSIF _channel IS NULL THEN
    INSERT INTO public.branch_products(tenant_id,branch_id,product_id,is_available,local_price)
    VALUES (_tenant_id,_branch_id,_product_id,true,
      CASE WHEN _amount_fils IS NULL THEN NULL ELSE public.fils_to_bhd_numeric(_amount_fils) END)
    ON CONFLICT (branch_id,product_id) DO UPDATE SET
      local_price=EXCLUDED.local_price;
  ELSIF _amount_fils IS NULL THEN
    DELETE FROM public.product_channel_prices
    WHERE tenant_id=_tenant_id AND product_id=_product_id
      AND branch_id IS NOT DISTINCT FROM _branch_id AND channel=_channel;
  ELSE
    IF _branch_id IS NULL THEN
      INSERT INTO public.product_channel_prices(tenant_id,product_id,branch_id,channel,price)
      VALUES (_tenant_id,_product_id,NULL,_channel,public.fils_to_bhd_numeric(_amount_fils))
      ON CONFLICT (product_id,channel) WHERE branch_id IS NULL
      DO UPDATE SET price=EXCLUDED.price;
    ELSE
      INSERT INTO public.product_channel_prices(tenant_id,product_id,branch_id,channel,price)
      VALUES (_tenant_id,_product_id,_branch_id,_channel,public.fils_to_bhd_numeric(_amount_fils))
      ON CONFLICT (product_id,channel,branch_id) WHERE branch_id IS NOT NULL
      DO UPDATE SET price=EXCLUDED.price;
    END IF;
  END IF;
  PERFORM set_config('zaipos.product_financial_command', _previous_setting, true);

  UPDATE public.product_financial_operations SET completed_at=now()
  WHERE tenant_id=_tenant_id AND operation_id=_operation_id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (_tenant_id,_actor_id,'catalogue.product_selling_price_changed','product',_product_id,
    jsonb_build_object(
      'operation_id',_operation_id,'reason',_reason,'branch_id',_branch_id,
      'channel',_channel,'previous_amount_fils',_current.amount_fils,'amount_fils',_amount_fils
    ));
  RETURN _product_id;
END
$$;

REVOKE ALL ON FUNCTION public.set_product_selling_price_v1(
  uuid,uuid,uuid,public.sales_channel,bigint,text,text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_product_selling_price_v1(
  uuid,uuid,uuid,public.sales_channel,bigint,text,text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_context_price_direct_write_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
    AND COALESCE(current_setting('zaipos.product_financial_command', true), '') <> 'on'
  THEN RAISE EXCEPTION 'Context selling-price changes must use an authoritative price command'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.guard_context_price_direct_write_v1() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER branch_products_price_insert_delete_guard
BEFORE INSERT OR DELETE ON public.branch_products
FOR EACH ROW EXECUTE FUNCTION public.guard_context_price_direct_write_v1();

CREATE TRIGGER branch_products_price_update_guard
BEFORE UPDATE OF local_price, local_price_fils ON public.branch_products
FOR EACH ROW EXECUTE FUNCTION public.guard_context_price_direct_write_v1();

CREATE TRIGGER product_channel_prices_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.product_channel_prices
FOR EACH ROW EXECUTE FUNCTION public.guard_context_price_direct_write_v1();

CREATE OR REPLACE FUNCTION public.capture_purchase_received_costs_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _line record;
  _actor_id uuid := auth.uid();
  _previous_setting text;
  _count integer := 0;
BEGIN
  IF NEW.status <> 'received' OR OLD.status = 'received' THEN RETURN NEW; END IF;
  FOR _line IN
    SELECT item.id, item.product_id, item.cost_price_fils
    FROM public.purchase_order_items item
    WHERE item.tenant_id=NEW.tenant_id AND item.order_id=NEW.id AND item.product_id IS NOT NULL
    ORDER BY item.product_id, item.id
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.product_prices WHERE purchase_order_item_id=_line.id) THEN
      PERFORM public.record_product_price_event_internal_v1(
        NEW.tenant_id,_line.product_id,'cost',_line.cost_price_fils,NEW.branch_id,NULL,
        _actor_id,'Supplier cost received for purchase order ' || NEW.id::text,
        'purchase_receipt','purchase-receipt-' || NEW.id::text,
        NEW.supplier_id,NEW.id,_line.id,COALESCE(NEW.received_at,now()),true
      );
      _count := _count + 1;
    END IF;
    _previous_setting := COALESCE(current_setting('zaipos.product_financial_command', true), '');
    PERFORM set_config('zaipos.product_financial_command', 'on', true);
    UPDATE public.products
    SET cost=public.fils_to_bhd_numeric(_line.cost_price_fils)
    WHERE tenant_id=NEW.tenant_id AND id=_line.product_id;
    PERFORM set_config('zaipos.product_financial_command', _previous_setting, true);
  END LOOP;

  IF _count > 0 THEN
    INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES (NEW.tenant_id,_actor_id,'purchase_order.costs_recorded','purchase_order',NEW.id,
      jsonb_build_object('branch_id',NEW.branch_id,'supplier_id',NEW.supplier_id,'cost_line_count',_count));
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.capture_purchase_received_costs_v1() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER purchase_orders_received_cost_history
AFTER UPDATE OF status ON public.purchase_orders
FOR EACH ROW EXECUTE FUNCTION public.capture_purchase_received_costs_v1();

ALTER TABLE public.sale_items
  ADD COLUMN unit_cost_fils bigint,
  ADD COLUMN line_cost_fils bigint,
  ADD COLUMN cost_price_id uuid REFERENCES public.product_prices(id) ON DELETE SET NULL,
  ADD COLUMN cost_basis text;

UPDATE public.sale_items item
SET unit_cost_fils = product.cost_fils,
    line_cost_fils = round(product.cost_fils::numeric * item.quantity)::bigint,
    cost_basis = 'legacy_current_cost_at_migration'
FROM public.products product
WHERE product.tenant_id=item.tenant_id AND product.id=item.product_id;

ALTER TABLE public.sale_items
  ALTER COLUMN unit_cost_fils SET NOT NULL,
  ALTER COLUMN line_cost_fils SET NOT NULL,
  ALTER COLUMN cost_basis SET NOT NULL,
  ADD CONSTRAINT sale_items_cost_fils_nonnegative CHECK (unit_cost_fils >= 0 AND line_cost_fils >= 0),
  ADD CONSTRAINT sale_items_cost_basis_check CHECK (
    cost_basis IN ('initial','manual','purchase_receipt','compatibility','legacy_backfill','legacy_current_cost_at_migration')
  );

CREATE INDEX sale_items_cost_price_idx ON public.sale_items(cost_price_id);

CREATE OR REPLACE FUNCTION public.snapshot_sale_item_cost_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _branch_id uuid;
  _price public.product_prices;
BEGIN
  SELECT branch_id INTO _branch_id
  FROM public.sales WHERE tenant_id=NEW.tenant_id AND id=NEW.sale_id;
  IF _branch_id IS NULL THEN RAISE EXCEPTION 'Sale cost snapshot requires a tenant-scoped sale'; END IF;

  SELECT * INTO _price FROM public.product_prices
  WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id AND price_type='cost'
    AND channel IS NULL
    AND effective_to IS NULL
    AND (branch_id=_branch_id OR branch_id IS NULL)
  ORDER BY (branch_id=_branch_id) DESC, effective_from DESC, id DESC
  LIMIT 1;

  IF _price.id IS NULL THEN
    SELECT cost_fils INTO NEW.unit_cost_fils
    FROM public.products WHERE tenant_id=NEW.tenant_id AND id=NEW.product_id;
    NEW.cost_price_id := NULL;
    NEW.cost_basis := 'legacy_current_cost_at_migration';
  ELSE
    NEW.unit_cost_fils := _price.amount_fils;
    NEW.cost_price_id := _price.id;
    NEW.cost_basis := _price.source;
  END IF;
  IF NEW.unit_cost_fils IS NULL THEN RAISE EXCEPTION 'Product cost is unavailable'; END IF;
  NEW.line_cost_fils := round(NEW.unit_cost_fils::numeric * NEW.quantity)::bigint;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.snapshot_sale_item_cost_v1() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER sale_items_cost_snapshot
BEFORE INSERT ON public.sale_items
FOR EACH ROW EXECUTE FUNCTION public.snapshot_sale_item_cost_v1();

CREATE OR REPLACE FUNCTION public.guard_sale_item_cost_snapshot_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.unit_cost_fils IS DISTINCT FROM OLD.unit_cost_fils
    OR NEW.line_cost_fils IS DISTINCT FROM OLD.line_cost_fils
    OR NEW.cost_price_id IS DISTINCT FROM OLD.cost_price_id
    OR NEW.cost_basis IS DISTINCT FROM OLD.cost_basis
  THEN RAISE EXCEPTION 'Historical sale cost evidence is immutable'; END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.guard_sale_item_cost_snapshot_v1() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER sale_items_cost_snapshot_immutable
BEFORE UPDATE OF unit_cost_fils,line_cost_fils,cost_price_id,cost_basis ON public.sale_items
FOR EACH ROW EXECUTE FUNCTION public.guard_sale_item_cost_snapshot_v1();

COMMIT;
