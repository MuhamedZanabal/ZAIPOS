-- Branch-scoped held carts with exact-fils snapshots and explicit resume conflicts.

BEGIN;

CREATE TABLE public.held_carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  channel public.sales_channel NOT NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  table_id uuid REFERENCES public.tables(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held','resumed','discarded')),
  client_operation_id text NOT NULL CHECK (length(trim(client_operation_id)) BETWEEN 8 AND 200),
  request_payload jsonb NOT NULL,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  resolution_operation_id text CHECK (
    resolution_operation_id IS NULL OR length(trim(resolution_operation_id)) BETWEEN 8 AND 200
  ),
  resolution_payload jsonb,
  resolved_result jsonb,
  discard_reason text CHECK (discard_reason IS NULL OR length(trim(discard_reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT held_carts_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, client_operation_id),
  UNIQUE (tenant_id, branch_id, id)
);

CREATE UNIQUE INDEX held_carts_resolution_operation_key
  ON public.held_carts(tenant_id, resolution_operation_id)
  WHERE resolution_operation_id IS NOT NULL;
CREATE INDEX held_carts_branch_status_created_idx
  ON public.held_carts(tenant_id, branch_id, status, created_at DESC);

CREATE TABLE public.held_cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  held_cart_id uuid NOT NULL,
  line_id text NOT NULL CHECK (length(trim(line_id)) BETWEEN 1 AND 300),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  product_name_snapshot text NOT NULL,
  product_type_snapshot public.product_type NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  expected_unit_price_fils bigint NOT NULL CHECK (expected_unit_price_fils >= 0),
  discount_fils bigint NOT NULL DEFAULT 0 CHECK (discount_fils >= 0),
  tax_rate_snapshot numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate_snapshot >= 0),
  modifiers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(modifiers) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT held_cart_items_cart_fkey
    FOREIGN KEY (tenant_id, branch_id, held_cart_id)
    REFERENCES public.held_carts(tenant_id, branch_id, id) ON DELETE CASCADE,
  CONSTRAINT held_cart_items_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (held_cart_id, line_id)
);

CREATE INDEX held_cart_items_cart_idx ON public.held_cart_items(held_cart_id, created_at, id);

ALTER TABLE public.held_carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.held_cart_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY held_carts_branch_select
ON public.held_carts FOR SELECT TO authenticated
USING (public.has_branch_role(
  (SELECT auth.uid()), tenant_id, branch_id,
  ARRAY['owner','admin','manager','cashier']::public.app_role[]
));

CREATE POLICY held_cart_items_branch_select
ON public.held_cart_items FOR SELECT TO authenticated
USING (public.has_branch_role(
  (SELECT auth.uid()), tenant_id, branch_id,
  ARRAY['owner','admin','manager','cashier']::public.app_role[]
));

REVOKE ALL ON TABLE public.held_carts, public.held_cart_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.held_carts, public.held_cart_items TO authenticated;

CREATE OR REPLACE FUNCTION public.build_held_cart_resume_preview(_held_cart_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _cart public.held_carts%ROWTYPE;
  _item public.held_cart_items%ROWTYPE;
  _product record;
  _issues jsonb;
  _items jsonb := '[]'::jsonb;
  _resolved_price_fils bigint;
  _modifier_delta_fils bigint;
  _modifier_requested integer;
  _modifier_valid integer;
  _available numeric;
  _dev_mode boolean;
  _product_found boolean;
BEGIN
  SELECT * INTO _cart FROM public.held_carts WHERE id = _held_cart_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Held cart does not exist'; END IF;

  SELECT dev_mode INTO _dev_mode FROM public.tenants WHERE id = _cart.tenant_id;

  FOR _item IN
    SELECT * FROM public.held_cart_items
    WHERE held_cart_id = _cart.id
    ORDER BY created_at, id
  LOOP
    _issues := '[]'::jsonb;
    _resolved_price_fils := NULL;
    _modifier_delta_fils := 0;
    _modifier_requested := jsonb_array_length(_item.modifiers);
    _modifier_valid := 0;
    _available := NULL;
    _product_found := false;

    SELECT
      p.id, p.tenant_id, p.name, p.product_type, p.status, p.tax_rate,
      p.category_id, p.image_url, p.sku, p.barcode, p.unit_code,
      p.station, p.color, p.description, p.sort_order, p.updated_at,
      COALESCE(
        (SELECT cp.price_fils FROM public.product_channel_prices cp
         WHERE cp.tenant_id = _cart.tenant_id AND cp.product_id = p.id
           AND cp.branch_id = _cart.branch_id AND cp.channel = _cart.channel LIMIT 1),
        (SELECT cp.price_fils FROM public.product_channel_prices cp
         WHERE cp.tenant_id = _cart.tenant_id AND cp.product_id = p.id
           AND cp.branch_id IS NULL AND cp.channel = _cart.channel LIMIT 1),
        bp.local_price_fils,
        p.price_fils
      ) AS base_price_fils,
      COALESCE(bp.is_available, true) AS branch_available
    INTO _product
    FROM public.products p
    LEFT JOIN public.branch_products bp
      ON bp.tenant_id = _cart.tenant_id
     AND bp.branch_id = _cart.branch_id
     AND bp.product_id = p.id
    WHERE p.id = _item.product_id AND p.tenant_id = _cart.tenant_id;

    _product_found := FOUND;

    IF NOT _product_found OR _product.status <> 'active' THEN
      _issues := _issues || '"product_discontinued"'::jsonb;
    END IF;

    IF _product_found AND NOT _product.branch_available THEN
      _issues := _issues || '"branch_unavailable"'::jsonb;
    END IF;

    IF _product_found AND _modifier_requested > 0 THEN
      SELECT COALESCE(sum(public.bhd_numeric_to_fils(mo.price_delta)), 0), count(*)
      INTO _modifier_delta_fils, _modifier_valid
      FROM jsonb_array_elements(_item.modifiers) selected
      JOIN public.modifier_options mo
        ON mo.id = (selected->>'option_id')::uuid AND mo.is_available = true
      JOIN public.modifier_groups mg ON mg.id = mo.group_id
      WHERE mg.tenant_id = _cart.tenant_id
        AND mg.product_id = _item.product_id;

      IF _modifier_valid <> _modifier_requested THEN
        _issues := _issues || '"modifier_unavailable"'::jsonb;
      END IF;
    END IF;

    IF _product_found AND _product.base_price_fils IS NOT NULL AND _modifier_valid = _modifier_requested THEN
      _resolved_price_fils := _product.base_price_fils + _modifier_delta_fils;
      IF _resolved_price_fils IS DISTINCT FROM _item.expected_unit_price_fils THEN
        _issues := _issues || '"price_changed"'::jsonb;
      END IF;
    END IF;

    IF _product_found AND NOT _dev_mode AND _product.product_type IN ('simple','production','combo') THEN
      SELECT COALESCE(sum(stock.quantity), 0)
      INTO _available
      FROM public.inventory_stocks stock
      WHERE stock.tenant_id = _cart.tenant_id
        AND stock.branch_id = _cart.branch_id
        AND stock.product_id = _item.product_id;
    ELSIF _product_found AND NOT _dev_mode AND _product.product_type = 'composite' THEN
      SELECT floor(min(COALESCE(stock.quantity, 0) /
        NULLIF(component.quantity * (1 + COALESCE(component.waste_pct, 0) / 100.0), 0)) * 1000) / 1000
      INTO _available
      FROM public.product_components component
      LEFT JOIN LATERAL (
        SELECT sum(level.quantity) AS quantity
        FROM public.inventory_stocks level
        WHERE level.tenant_id = _cart.tenant_id
          AND level.branch_id = _cart.branch_id
          AND level.product_id = component.component_product_id
      ) stock ON true
      WHERE component.tenant_id = _cart.tenant_id
        AND component.parent_product_id = _item.product_id;
    END IF;

    IF _available IS NOT NULL AND _available < _item.quantity THEN
      _issues := _issues || '"insufficient_stock"'::jsonb;
    END IF;

    _items := _items || jsonb_build_array(jsonb_build_object(
      'line_id', _item.line_id,
      'product_id', _item.product_id,
      'product_name', _item.product_name_snapshot,
      'product_type', _item.product_type_snapshot,
      'quantity', _item.quantity,
      'expected_unit_price_fils', _item.expected_unit_price_fils,
      'current_unit_price_fils', _resolved_price_fils,
      'discount_fils', _item.discount_fils,
      'available_quantity', _available,
      'modifiers', _item.modifiers,
      'issues', _issues,
      'product', CASE WHEN _product_found THEN jsonb_build_object(
        'id', _product.id,
        'tenant_id', _product.tenant_id,
        'name', _product.name,
        'product_type', _product.product_type,
        'status', _product.status,
        'tax_rate', _product.tax_rate,
        'category_id', _product.category_id,
        'image_url', _product.image_url,
        'sku', _product.sku,
        'barcode', _product.barcode,
        'unit_code', _product.unit_code,
        'station', _product.station,
        'color', _product.color,
        'description', _product.description,
        'sort_order', _product.sort_order,
        'updated_at', _product.updated_at,
        'price_fils', _resolved_price_fils
      ) ELSE NULL END
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'cart', jsonb_build_object(
      'id', _cart.id,
      'label', _cart.label,
      'channel', _cart.channel,
      'customer_id', _cart.customer_id,
      'table_id', _cart.table_id
    ),
    'items', _items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.build_held_cart_resume_preview(uuid)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.hold_cart_v1(
  _branch_id uuid,
  _label text,
  _channel public.sales_channel,
  _customer_id uuid,
  _table_id uuid,
  _items jsonb,
  _client_operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor uuid := auth.uid();
  _tenant_id uuid;
  _request jsonb;
  _cart_id uuid;
  _existing public.held_carts%ROWTYPE;
  _item jsonb;
  _product record;
  _quantity numeric;
  _price_fils bigint;
  _discount_fils bigint;
  _modifier_count integer;
BEGIN
  SELECT tenant_id INTO _tenant_id
  FROM public.branches
  WHERE id = _branch_id AND status = 'active';

  IF _actor IS NULL OR _tenant_id IS NULL OR NOT public.has_branch_role(
    _actor, _tenant_id, _branch_id,
    ARRAY['owner','admin','manager','cashier']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Held cart is not authorized'; END IF;

  _label := NULLIF(trim(COALESCE(_label, '')), '');
  _client_operation_id := NULLIF(trim(COALESCE(_client_operation_id, '')), '');
  IF _label IS NULL OR length(_label) > 120 THEN RAISE EXCEPTION 'Held cart label is required'; END IF;
  IF _client_operation_id IS NULL OR length(_client_operation_id) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'A valid held cart operation ID is required';
  END IF;
  IF _items IS NULL OR jsonb_typeof(_items) <> 'array'
     OR jsonb_array_length(_items) = 0 OR jsonb_array_length(_items) > 200 THEN
    RAISE EXCEPTION 'Held cart must contain between 1 and 200 lines';
  END IF;
  IF _customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customers WHERE id = _customer_id AND tenant_id = _tenant_id
  ) THEN RAISE EXCEPTION 'Held cart customer is invalid'; END IF;
  IF _table_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tables WHERE id = _table_id AND tenant_id = _tenant_id AND branch_id = _branch_id
  ) THEN RAISE EXCEPTION 'Held cart table is invalid'; END IF;

  _request := jsonb_build_object(
    'branch_id', _branch_id, 'label', _label, 'channel', _channel,
    'customer_id', _customer_id, 'table_id', _table_id, 'items', _items
  );

  INSERT INTO public.held_carts(
    tenant_id, branch_id, created_by, label, channel, customer_id, table_id,
    client_operation_id, request_payload
  ) VALUES (
    _tenant_id, _branch_id, _actor, _label, _channel, _customer_id, _table_id,
    _client_operation_id, _request
  )
  ON CONFLICT (tenant_id, client_operation_id) DO NOTHING
  RETURNING id INTO _cart_id;

  IF _cart_id IS NULL THEN
    SELECT * INTO _existing FROM public.held_carts
    WHERE tenant_id = _tenant_id AND client_operation_id = _client_operation_id
    FOR UPDATE;
    IF _existing.created_by <> _actor OR _existing.request_payload IS DISTINCT FROM _request THEN
      RAISE EXCEPTION 'Held cart operation ID conflicts with another request';
    END IF;
    RETURN _existing.id;
  END IF;

  FOR _item IN SELECT value FROM jsonb_array_elements(_items) LOOP
    BEGIN
      _quantity := (_item->>'quantity')::numeric;
      _price_fils := (_item->>'expected_unit_price_fils')::bigint;
      _discount_fils := COALESCE((_item->>'discount_fils')::bigint, 0);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Held cart quantity and money values are invalid';
    END;
    IF length(trim(COALESCE(_item->>'line_id',''))) NOT BETWEEN 1 AND 300
       OR _quantity IS NULL OR _quantity <= 0 OR _quantity <> round(_quantity, 3)
       OR _price_fils IS NULL OR _price_fils < 0 OR _discount_fils < 0
       OR _discount_fils > round(_price_fils::numeric * _quantity)::bigint THEN
      RAISE EXCEPTION 'Held cart line is invalid';
    END IF;
    IF jsonb_typeof(COALESCE(_item->'modifiers','[]'::jsonb)) <> 'array' THEN
      RAISE EXCEPTION 'Held cart modifiers must be an array';
    END IF;

    SELECT id, name, product_type, tax_rate INTO _product
    FROM public.products
    WHERE id = (_item->>'product_id')::uuid
      AND tenant_id = _tenant_id AND status = 'active';
    IF NOT FOUND THEN RAISE EXCEPTION 'Held cart product is invalid or inactive'; END IF;

    SELECT count(*) INTO _modifier_count
    FROM jsonb_array_elements(COALESCE(_item->'modifiers','[]'::jsonb)) selected
    JOIN public.modifier_options option ON option.id = (selected->>'option_id')::uuid
    JOIN public.modifier_groups modifier_group ON modifier_group.id = option.group_id
    WHERE modifier_group.tenant_id = _tenant_id
      AND modifier_group.product_id = _product.id;
    IF _modifier_count <> jsonb_array_length(COALESCE(_item->'modifiers','[]'::jsonb)) THEN
      RAISE EXCEPTION 'Held cart contains an invalid modifier';
    END IF;

    INSERT INTO public.held_cart_items(
      tenant_id, branch_id, held_cart_id, line_id, product_id,
      product_name_snapshot, product_type_snapshot, quantity,
      expected_unit_price_fils, discount_fils, tax_rate_snapshot, modifiers
    ) VALUES (
      _tenant_id, _branch_id, _cart_id, trim(_item->>'line_id'), _product.id,
      _product.name, _product.product_type, _quantity,
      _price_fils, _discount_fils, _product.tax_rate,
      COALESCE(_item->'modifiers','[]'::jsonb)
    );
  END LOOP;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (_tenant_id,_actor,'pos.cart_held','held_carts',_cart_id,jsonb_build_object(
    'branch_id',_branch_id,'client_operation_id',_client_operation_id,
    'line_count',jsonb_array_length(_items),'label',_label
  ));
  RETURN _cart_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_held_carts_v1(_branch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor uuid := auth.uid();
  _tenant_id uuid;
BEGIN
  SELECT tenant_id INTO _tenant_id FROM public.branches WHERE id = _branch_id;
  IF _actor IS NULL OR _tenant_id IS NULL OR NOT public.has_branch_role(
    _actor,_tenant_id,_branch_id,ARRAY['owner','admin','manager','cashier']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Held cart list is not authorized'; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', cart.id,
      'label', cart.label,
      'item_count', totals.item_count,
      'total_fils', totals.total_fils,
      'channel', cart.channel,
      'customer_name', customer.name,
      'created_at', cart.created_at,
      'created_by_name', COALESCE(profile.full_name, profile.email, 'Unknown cashier')
    ) ORDER BY cart.created_at DESC)
    FROM public.held_carts cart
    LEFT JOIN public.profiles profile ON profile.id = cart.created_by
    LEFT JOIN public.customers customer ON customer.id = cart.customer_id AND customer.tenant_id = cart.tenant_id
    JOIN LATERAL (
      SELECT count(*)::integer AS item_count,
        COALESCE(sum(
          (round(item.expected_unit_price_fils::numeric * item.quantity)::bigint - item.discount_fils)
          + round((round(item.expected_unit_price_fils::numeric * item.quantity)::bigint - item.discount_fils)::numeric * item.tax_rate_snapshot / 100)::bigint
        ),0)::bigint AS total_fils
      FROM public.held_cart_items item WHERE item.held_cart_id = cart.id
    ) totals ON true
    WHERE cart.tenant_id = _tenant_id AND cart.branch_id = _branch_id AND cart.status = 'held'
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.preview_held_cart_resume_v1(_held_cart_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor uuid := auth.uid();
  _cart public.held_carts%ROWTYPE;
BEGIN
  SELECT * INTO _cart FROM public.held_carts WHERE id = _held_cart_id;
  IF _actor IS NULL OR NOT FOUND OR _cart.status <> 'held' OR NOT public.has_branch_role(
    _actor,_cart.tenant_id,_cart.branch_id,ARRAY['owner','admin','manager','cashier']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Held cart resume is not authorized'; END IF;
  RETURN public.build_held_cart_resume_preview(_cart.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_held_cart_v1(
  _held_cart_id uuid,
  _resolutions jsonb,
  _client_operation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor uuid := auth.uid();
  _cart public.held_carts%ROWTYPE;
  _preview jsonb;
  _item jsonb;
  _resolution jsonb;
  _result_items jsonb := '[]'::jsonb;
  _result jsonb;
  _issues jsonb;
  _remove boolean;
  _accept_price boolean;
  _quantity numeric;
BEGIN
  _client_operation_id := NULLIF(trim(COALESCE(_client_operation_id,'')), '');
  IF _client_operation_id IS NULL OR length(_client_operation_id) NOT BETWEEN 8 AND 200
     OR _resolutions IS NULL OR jsonb_typeof(_resolutions) <> 'array' THEN
    RAISE EXCEPTION 'Held cart resume request is invalid';
  END IF;

  SELECT * INTO _cart FROM public.held_carts WHERE id = _held_cart_id FOR UPDATE;
  IF _actor IS NULL OR NOT FOUND OR NOT public.has_branch_role(
    _actor,_cart.tenant_id,_cart.branch_id,ARRAY['owner','admin','manager','cashier']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Held cart resume is not authorized'; END IF;

  IF _cart.status = 'resumed'
     AND _cart.resolution_operation_id = _client_operation_id
     AND _cart.resolution_payload IS NOT DISTINCT FROM _resolutions THEN
    RETURN _cart.resolved_result;
  END IF;
  IF _cart.status <> 'held' THEN RAISE EXCEPTION 'Held cart was already resolved'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(_resolutions)) <>
     (SELECT count(DISTINCT value->>'line_id') FROM jsonb_array_elements(_resolutions)) THEN
    RAISE EXCEPTION 'Held cart resolutions contain duplicate line IDs';
  END IF;

  _preview := public.build_held_cart_resume_preview(_cart.id);
  IF jsonb_array_length(_resolutions) <> jsonb_array_length(_preview->'items') THEN
    RAISE EXCEPTION 'Every held cart line requires a resume resolution';
  END IF;

  FOR _item IN SELECT value FROM jsonb_array_elements(_preview->'items') LOOP
    SELECT value INTO _resolution
    FROM jsonb_array_elements(_resolutions)
    WHERE value->>'line_id' = _item->>'line_id';
    IF NOT FOUND THEN RAISE EXCEPTION 'Every held cart line requires a resume resolution'; END IF;

    _issues := COALESCE(_item->'issues','[]'::jsonb);
    _remove := COALESCE((_resolution->>'remove')::boolean, false);
    _accept_price := COALESCE((_resolution->>'accept_current_price')::boolean, false);
    BEGIN _quantity := (_resolution->>'quantity')::numeric;
    EXCEPTION WHEN others THEN RAISE EXCEPTION 'Held cart resolution quantity is invalid'; END;

    IF _remove THEN CONTINUE; END IF;
    IF _quantity IS NULL OR _quantity <= 0 OR _quantity > (_item->>'quantity')::numeric OR _quantity <> round(_quantity,3) THEN
      RAISE EXCEPTION 'Held cart resolution quantity is invalid';
    END IF;
    IF _issues ?| ARRAY['product_discontinued','branch_unavailable','modifier_unavailable'] THEN
      RAISE EXCEPTION 'Unavailable held cart items must be removed';
    END IF;
    IF _issues ? 'price_changed' AND NOT _accept_price THEN
      RAISE EXCEPTION 'Changed held cart prices require explicit acceptance';
    END IF;
    IF _issues ? 'insufficient_stock' AND (
      (_item->>'available_quantity') IS NULL OR _quantity > (_item->>'available_quantity')::numeric
    ) THEN RAISE EXCEPTION 'Held cart quantity exceeds current stock'; END IF;

    _result_items := _result_items || jsonb_build_array(
      _item || jsonb_build_object('quantity',_quantity,'issues','[]'::jsonb)
    );
  END LOOP;

  IF jsonb_array_length(_result_items) = 0 THEN
    RAISE EXCEPTION 'At least one available item is required to resume a held cart';
  END IF;
  _result := jsonb_build_object('cart',_preview->'cart','items',_result_items);

  UPDATE public.held_carts SET
    status='resumed', resolved_by=_actor, resolution_operation_id=_client_operation_id,
    resolution_payload=_resolutions, resolved_result=_result, resolved_at=now(), updated_at=now()
  WHERE id = _cart.id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (_cart.tenant_id,_actor,'pos.cart_resumed','held_carts',_cart.id,jsonb_build_object(
    'branch_id',_cart.branch_id,'client_operation_id',_client_operation_id,
    'resumed_line_count',jsonb_array_length(_result_items)
  ));
  RETURN _result;
END;
$$;

CREATE OR REPLACE FUNCTION public.discard_held_cart_v1(
  _held_cart_id uuid,
  _reason text,
  _client_operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor uuid := auth.uid();
  _cart public.held_carts%ROWTYPE;
  _payload jsonb;
BEGIN
  _reason := NULLIF(trim(COALESCE(_reason,'')), '');
  _client_operation_id := NULLIF(trim(COALESCE(_client_operation_id,'')), '');
  IF _reason IS NULL OR length(_reason) > 500 OR _client_operation_id IS NULL
     OR length(_client_operation_id) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'Held cart discard request is invalid';
  END IF;
  _payload := jsonb_build_object('reason',_reason);

  SELECT * INTO _cart FROM public.held_carts WHERE id = _held_cart_id FOR UPDATE;
  IF _actor IS NULL OR NOT FOUND OR NOT public.has_branch_role(
    _actor,_cart.tenant_id,_cart.branch_id,ARRAY['owner','admin','manager','cashier']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Held cart discard is not authorized'; END IF;
  IF _cart.status = 'discarded' AND _cart.resolution_operation_id = _client_operation_id
     AND _cart.resolution_payload IS NOT DISTINCT FROM _payload THEN RETURN _cart.id; END IF;
  IF _cart.status <> 'held' THEN RAISE EXCEPTION 'Held cart was already resolved'; END IF;

  UPDATE public.held_carts SET
    status='discarded', resolved_by=_actor, resolution_operation_id=_client_operation_id,
    resolution_payload=_payload, discard_reason=_reason, resolved_at=now(), updated_at=now()
  WHERE id = _cart.id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (_cart.tenant_id,_actor,'pos.cart_discarded','held_carts',_cart.id,jsonb_build_object(
    'branch_id',_cart.branch_id,'client_operation_id',_client_operation_id,'reason',_reason
  ));
  RETURN _cart.id;
END;
$$;

REVOKE ALL ON FUNCTION public.hold_cart_v1(uuid,text,public.sales_channel,uuid,uuid,jsonb,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_held_carts_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.preview_held_cart_resume_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resume_held_cart_v1(uuid,jsonb,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.discard_held_cart_v1(uuid,text,text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.hold_cart_v1(uuid,text,public.sales_channel,uuid,uuid,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_held_carts_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_held_cart_resume_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resume_held_cart_v1(uuid,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.discard_held_cart_v1(uuid,text,text) TO authenticated;

COMMIT;
