-- P0 restaurant order-item authority.
--
-- Renderer INSERT/UPDATE/DELETE followed by a separate total recalculation was
-- neither atomic nor replay-safe. All writes now pass through one branch- and
-- role-scoped command with an immutable operation journal. SELECT remains RLS
-- protected; application roles cannot mutate the table directly.

BEGIN;

DROP POLICY IF EXISTS toi_member_all ON public.table_order_items;
REVOKE INSERT, UPDATE, DELETE ON public.table_order_items FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recalc_table_order(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mutate_table_order_item_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _order_id uuid,
  _operation_id text,
  _action text,
  _item_id uuid DEFAULT NULL,
  _product_id uuid DEFAULT NULL,
  _quantity numeric DEFAULT NULL,
  _notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _user_id uuid := auth.uid();
  _order public.table_orders;
  _item public.table_order_items;
  _product record;
  _request jsonb;
  _existing public.operation_log;
  _journal_id uuid;
  _result_id uuid;
  _normalized_notes text := NULLIF(btrim(COALESCE(_notes, '')), '');
  _resolved_price_fils bigint;
  _subtotal_fils bigint;
  _tax_fils bigint;
  _total_fils bigint;
  _discount_fils bigint;
  _order_subtotal_fils bigint;
  _order_tax_fils bigint;
  _is_elevated boolean;
  _is_waiter boolean;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  _operation_id := NULLIF(btrim(COALESCE(_operation_id, '')), '');
  _action := lower(NULLIF(btrim(COALESCE(_action, '')), ''));
  IF _operation_id IS NULL OR length(_operation_id) < 8 OR length(_operation_id) > 200 THEN
    RAISE EXCEPTION 'A stable table-item operation ID is required';
  END IF;
  IF _action IS NULL OR _action NOT IN ('add','set_quantity','delete') THEN
    RAISE EXCEPTION 'Unsupported table-item action';
  END IF;
  IF _normalized_notes IS NOT NULL AND length(_normalized_notes) > 1000 THEN
    RAISE EXCEPTION 'Table-item notes are too long';
  END IF;

  SELECT * INTO _order FROM public.table_orders WHERE id = _order_id FOR UPDATE;
  IF NOT FOUND OR _order.tenant_id IS DISTINCT FROM _tenant_id OR _order.branch_id IS DISTINCT FROM _branch_id THEN
    RAISE EXCEPTION 'Table order is outside the authorized branch scope' USING ERRCODE = '42501';
  END IF;
  IF _order.status IS DISTINCT FROM 'open'::public.table_order_status THEN
    RAISE EXCEPTION 'Only an open table order can be changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id=_branch_id AND tenant_id=_tenant_id AND status='active') THEN
    RAISE EXCEPTION 'Table order branch is inactive' USING ERRCODE = '42501';
  END IF;

  _is_elevated := public.has_branch_role(
    _user_id,_tenant_id,_branch_id,
    ARRAY['owner','admin','manager','cashier']::public.app_role[]
  );
  _is_waiter := public.has_branch_role(
    _user_id,_tenant_id,_branch_id,
    ARRAY['waiter']::public.app_role[]
  );
  IF NOT (_is_elevated OR _is_waiter) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  IF _is_waiter AND NOT _is_elevated AND _order.waiter_id IS DISTINCT FROM _user_id THEN
    RAISE EXCEPTION 'Waiter is not assigned to this table order' USING ERRCODE = '42501';
  END IF;

  IF _action = 'add' THEN
    IF _product_id IS NULL THEN RAISE EXCEPTION 'Product is required'; END IF;
    IF _quantity IS NULL OR _quantity <= 0 OR _quantity <> round(_quantity,3) THEN
      RAISE EXCEPTION 'Table-item quantity must be positive with at most three decimal places';
    END IF;
  ELSE
    IF _item_id IS NULL THEN RAISE EXCEPTION 'Table item is required'; END IF;
    IF _action = 'set_quantity' AND (_quantity IS NULL OR _quantity <= 0 OR _quantity <> round(_quantity,3)) THEN
      RAISE EXCEPTION 'Table-item quantity must be positive with at most three decimal places';
    END IF;
  END IF;

  _request := jsonb_build_object(
    'tenant_id',_tenant_id,'branch_id',_branch_id,'order_id',_order_id,
    'action',_action,'item_id',_item_id,'product_id',_product_id,
    'quantity',_quantity,'notes',_normalized_notes
  );

  INSERT INTO public.operation_log(
    tenant_id,branch_id,operation_type,client_mutation_id,status,entity_type,payload
  ) VALUES (
    _tenant_id,_branch_id,'mutate_table_order_item_v2',_operation_id,'processing','table_order_items',_request
  ) ON CONFLICT (tenant_id,client_mutation_id) DO NOTHING
  RETURNING id INTO _journal_id;

  IF _journal_id IS NULL THEN
    SELECT * INTO _existing FROM public.operation_log
    WHERE tenant_id=_tenant_id AND client_mutation_id=_operation_id
    FOR UPDATE;
    IF NOT FOUND
       OR _existing.branch_id IS DISTINCT FROM _branch_id
       OR _existing.operation_type IS DISTINCT FROM 'mutate_table_order_item_v2'
       OR _existing.payload IS DISTINCT FROM _request
    THEN
      RAISE EXCEPTION 'Table-item operation ID was already used for a different request';
    END IF;
    IF _existing.status = 'success' AND _existing.entity_id IS NOT NULL THEN RETURN _existing.entity_id; END IF;
    RAISE EXCEPTION 'Table-item operation is already processing';
  END IF;

  IF _action = 'add' THEN
    SELECT
      p.id,p.name,p.product_type,COALESCE(p.tax_rate,0) AS tax_rate,p.requires_detail,
      COALESCE(
        (SELECT cp.price_fils FROM public.product_channel_prices cp
         WHERE cp.tenant_id=_tenant_id AND cp.product_id=p.id AND cp.branch_id=_branch_id AND cp.channel='tables' LIMIT 1),
        (SELECT cp.price_fils FROM public.product_channel_prices cp
         WHERE cp.tenant_id=_tenant_id AND cp.product_id=p.id AND cp.branch_id IS NULL AND cp.channel='tables' LIMIT 1),
        bp.local_price_fils,p.price_fils
      ) AS price_fils
    INTO _product
    FROM public.products p
    LEFT JOIN public.branch_products bp
      ON bp.tenant_id=_tenant_id AND bp.branch_id=_branch_id AND bp.product_id=p.id
    WHERE p.id=_product_id AND p.tenant_id=_tenant_id AND p.status='active'
      AND COALESCE(bp.is_available,true)=true;
    IF NOT FOUND OR _product.price_fils IS NULL THEN RAISE EXCEPTION 'Product is unavailable for this branch'; END IF;
    IF COALESCE(_product.requires_detail,false) AND _normalized_notes IS NULL THEN
      RAISE EXCEPTION 'Product details are required';
    END IF;
    _resolved_price_fils := _product.price_fils;

    _item := NULL;
    IF _normalized_notes IS NULL THEN
      SELECT * INTO _item FROM public.table_order_items
      WHERE tenant_id=_tenant_id AND order_id=_order_id AND product_id=_product_id
        AND status='pending' AND notes IS NULL
      ORDER BY created_at LIMIT 1 FOR UPDATE;
    END IF;

    IF _item.id IS NOT NULL THEN
      _quantity := _item.quantity + _quantity;
      _subtotal_fils := round(_resolved_price_fils::numeric * _quantity)::bigint;
      _tax_fils := round(_subtotal_fils::numeric * _product.tax_rate / 100)::bigint;
      _total_fils := _subtotal_fils + _tax_fils;
      UPDATE public.table_order_items SET quantity=_quantity,
        line_total=public.fils_to_bhd_numeric(_total_fils)
      WHERE id=_item.id RETURNING id INTO _result_id;
    ELSE
      _subtotal_fils := round(_resolved_price_fils::numeric * _quantity)::bigint;
      _tax_fils := round(_subtotal_fils::numeric * _product.tax_rate / 100)::bigint;
      _total_fils := _subtotal_fils + _tax_fils;
      INSERT INTO public.table_order_items(
        tenant_id,order_id,product_id,product_name,product_type,quantity,
        unit_price,tax_rate,discount,line_total,status,notes
      ) VALUES (
        _tenant_id,_order_id,_product.id,_product.name,_product.product_type,_quantity,
        public.fils_to_bhd_numeric(_resolved_price_fils),_product.tax_rate,0,
        public.fils_to_bhd_numeric(_total_fils),'pending',_normalized_notes
      ) RETURNING id INTO _result_id;
    END IF;
  ELSE
    SELECT * INTO _item FROM public.table_order_items
    WHERE id=_item_id AND tenant_id=_tenant_id AND order_id=_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Table item is outside the authorized order scope' USING ERRCODE = '42501'; END IF;
    IF _item.status IS DISTINCT FROM 'pending'::public.table_item_status THEN
      RAISE EXCEPTION 'Only pending table items can be changed';
    END IF;
    _result_id := _item.id;
    IF _action = 'delete' THEN
      DELETE FROM public.table_order_items WHERE id=_item.id;
    ELSE
      _resolved_price_fils := public.bhd_numeric_to_fils(_item.unit_price);
      _discount_fils := public.bhd_numeric_to_fils(COALESCE(_item.discount,0));
      _subtotal_fils := round(_resolved_price_fils::numeric * _quantity)::bigint - _discount_fils;
      IF _subtotal_fils < 0 THEN RAISE EXCEPTION 'Table-item discount exceeds its subtotal'; END IF;
      _tax_fils := round(_subtotal_fils::numeric * COALESCE(_item.tax_rate,0) / 100)::bigint;
      _total_fils := _subtotal_fils + _tax_fils;
      UPDATE public.table_order_items SET quantity=_quantity,
        line_total=public.fils_to_bhd_numeric(_total_fils)
      WHERE id=_item.id;
    END IF;
  END IF;

  SELECT
    COALESCE(sum(amounts.subtotal_fils),0)::bigint,
    COALESCE(sum(round(amounts.subtotal_fils::numeric * amounts.tax_rate / 100)),0)::bigint
  INTO _order_subtotal_fils,_order_tax_fils
  FROM (
    SELECT
      round(public.bhd_numeric_to_fils(i.unit_price)::numeric * i.quantity)::bigint
        - public.bhd_numeric_to_fils(COALESCE(i.discount,0)) AS subtotal_fils,
      COALESCE(i.tax_rate,0) AS tax_rate
    FROM public.table_order_items i
    WHERE i.order_id=_order_id AND i.status <> 'cancelled'
  ) amounts;
  IF _order_subtotal_fils < 0 OR _order_tax_fils < 0 THEN
    RAISE EXCEPTION 'Table order totals cannot be negative';
  END IF;
  UPDATE public.table_orders SET
    subtotal=public.fils_to_bhd_numeric(_order_subtotal_fils),
    tax_total=public.fils_to_bhd_numeric(_order_tax_fils),
    total=public.fils_to_bhd_numeric(_order_subtotal_fils+_order_tax_fils),
    updated_at=now()
  WHERE id=_order_id;
  UPDATE public.operation_log SET status='success',entity_id=_result_id
  WHERE id=_journal_id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_user_id,'table_order_item.'||_action,'table_order_items',_result_id,
    jsonb_build_object('branch_id',_branch_id,'order_id',_order_id,'operation_id',_operation_id));
  RETURN _result_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.mutate_table_order_item_v2(uuid,uuid,uuid,text,text,uuid,uuid,numeric,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mutate_table_order_item_v2(uuid,uuid,uuid,text,text,uuid,uuid,numeric,text)
TO authenticated;

COMMIT;
