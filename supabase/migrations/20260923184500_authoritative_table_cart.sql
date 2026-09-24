-- Atomic cart-to-table authority. Only catalogue identities, quantities,
-- modifier option identities and notes cross the renderer boundary. Product
-- names, prices, tax, modifier deltas, discounts and totals are server-owned.

BEGIN;

CREATE OR REPLACE FUNCTION public.append_table_cart_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _table_id uuid,
  _operation_id text,
  _items jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $function$
DECLARE
  _user_id uuid:=auth.uid();
  _order public.table_orders;
  _item jsonb;
  _product record;
  _group record;
  _request jsonb;
  _existing public.operation_log;
  _journal_id uuid;
  _quantity numeric;
  _notes text;
  _modifier_ids jsonb;
  _modifier_snapshot jsonb;
  _modifier_count integer;
  _selected_count integer;
  _modifier_delta_fils bigint;
  _unit_price_fils bigint;
  _line_subtotal_fils bigint;
  _line_tax_fils bigint;
  _line_total_fils bigint;
  _order_subtotal_fils bigint;
  _order_tax_fils bigint;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  _operation_id:=NULLIF(btrim(COALESCE(_operation_id,'')),'');
  IF _operation_id IS NULL OR length(_operation_id)<8 OR length(_operation_id)>200 THEN
    RAISE EXCEPTION 'A stable table-cart operation ID is required';
  END IF;
  IF _items IS NULL OR jsonb_typeof(_items)<>'array' OR jsonb_array_length(_items)<1 OR jsonb_array_length(_items)>100 THEN
    RAISE EXCEPTION 'Table cart must contain between 1 and 100 items';
  END IF;

  -- The scoped order-opening command locks the table, verifies active branch,
  -- role and waiter assignment, and converges competing requests on one order.
  SELECT * INTO _order FROM public.open_table_order_v2(
    _tenant_id,_branch_id,_table_id,'table-cart-open:'||md5(_operation_id)
  );
  SELECT * INTO _order FROM public.table_orders WHERE id=_order.id FOR UPDATE;
  IF _order.status IS DISTINCT FROM 'open'::public.table_order_status THEN
    RAISE EXCEPTION 'Only an open table order can receive cart items';
  END IF;

  _request:=jsonb_build_object('tenant_id',_tenant_id,'branch_id',_branch_id,'table_id',_table_id,'items',_items);
  INSERT INTO public.operation_log(tenant_id,branch_id,operation_type,client_mutation_id,status,entity_type,payload)
  VALUES(_tenant_id,_branch_id,'append_table_cart_v2',_operation_id,'processing','table_orders',_request)
  ON CONFLICT(tenant_id,client_mutation_id) DO NOTHING RETURNING id INTO _journal_id;
  IF _journal_id IS NULL THEN
    SELECT * INTO _existing FROM public.operation_log
    WHERE tenant_id=_tenant_id AND client_mutation_id=_operation_id FOR UPDATE;
    IF NOT FOUND OR _existing.branch_id IS DISTINCT FROM _branch_id
       OR _existing.operation_type IS DISTINCT FROM 'append_table_cart_v2'
       OR _existing.payload IS DISTINCT FROM _request THEN
      RAISE EXCEPTION 'Table-cart operation ID was already used for a different request';
    END IF;
    IF _existing.status='success' AND _existing.entity_id IS NOT NULL THEN RETURN _existing.entity_id; END IF;
    RAISE EXCEPTION 'Table-cart operation is already processing';
  END IF;

  FOR _item IN SELECT value FROM jsonb_array_elements(_items) LOOP
    IF jsonb_typeof(_item)<>'object' OR EXISTS(
      SELECT 1 FROM jsonb_object_keys(_item) keys(key)
      WHERE key NOT IN ('product_id','quantity','modifier_option_ids','notes')
    ) THEN
      RAISE EXCEPTION 'Table-cart items may contain only product, quantity, modifier identities and notes';
    END IF;
    BEGIN
      _quantity:=(_item->>'quantity')::numeric;
      PERFORM (_item->>'product_id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Table-cart product and quantity are invalid';
    END;
    IF _quantity<=0 OR _quantity<>round(_quantity,3) THEN
      RAISE EXCEPTION 'Table-cart quantity must be positive with at most three decimal places';
    END IF;
    _notes:=NULLIF(btrim(COALESCE(_item->>'notes','')),'');
    IF _notes IS NOT NULL AND length(_notes)>1000 THEN RAISE EXCEPTION 'Table-item notes are too long'; END IF;
    _modifier_ids:=COALESCE(_item->'modifier_option_ids','[]'::jsonb);
    IF jsonb_typeof(_modifier_ids)<>'array' THEN RAISE EXCEPTION 'Modifier option identities must be an array'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(_modifier_ids) v WHERE jsonb_typeof(v)<>'string') THEN
      RAISE EXCEPTION 'Modifier option identities must be strings';
    END IF;

    SELECT p.id,p.name,p.product_type,COALESCE(p.tax_rate,0) tax_rate,p.requires_detail,
      COALESCE(
        (SELECT cp.price_fils FROM public.product_channel_prices cp WHERE cp.tenant_id=_tenant_id AND cp.product_id=p.id AND cp.branch_id=_branch_id AND cp.channel='tables' LIMIT 1),
        (SELECT cp.price_fils FROM public.product_channel_prices cp WHERE cp.tenant_id=_tenant_id AND cp.product_id=p.id AND cp.branch_id IS NULL AND cp.channel='tables' LIMIT 1),
        bp.local_price_fils,p.price_fils
      ) price_fils
    INTO _product FROM public.products p
    LEFT JOIN public.branch_products bp ON bp.tenant_id=_tenant_id AND bp.branch_id=_branch_id AND bp.product_id=p.id
    WHERE p.id=(_item->>'product_id')::uuid AND p.tenant_id=_tenant_id AND p.status='active'
      AND COALESCE(bp.is_available,true)=true;
    IF NOT FOUND OR _product.price_fils IS NULL THEN RAISE EXCEPTION 'Product is unavailable for this branch'; END IF;
    IF COALESCE(_product.requires_detail,false) AND _notes IS NULL THEN RAISE EXCEPTION 'Product details are required'; END IF;

    SELECT count(*),count(DISTINCT value) INTO _modifier_count,_selected_count FROM jsonb_array_elements_text(_modifier_ids);
    IF _modifier_count<>_selected_count THEN RAISE EXCEPTION 'Duplicate modifier options are not allowed'; END IF;
    SELECT COALESCE(sum(public.bhd_numeric_to_fils(mo.price_delta)),0),
      COALESCE(jsonb_agg(jsonb_build_object('option_id',mo.id,'group_id',mg.id,'name',mo.name,'price_delta',mo.price_delta) ORDER BY mg.sort_order,mo.sort_order),'[]'::jsonb),
      count(*)
    INTO _modifier_delta_fils,_modifier_snapshot,_selected_count
    FROM jsonb_array_elements_text(_modifier_ids) selected(option_id)
    JOIN public.modifier_options mo ON mo.id=selected.option_id::uuid AND mo.is_available=true
    JOIN public.modifier_groups mg ON mg.id=mo.group_id AND mg.tenant_id=_tenant_id AND mg.product_id=_product.id;
    IF _selected_count<>_modifier_count THEN RAISE EXCEPTION 'One or more product modifiers are invalid or unavailable'; END IF;

    FOR _group IN SELECT id,required,min_selections,max_selections FROM public.modifier_groups
      WHERE tenant_id=_tenant_id AND product_id=_product.id LOOP
      SELECT count(*) INTO _selected_count FROM jsonb_array_elements_text(_modifier_ids) selected(option_id)
      JOIN public.modifier_options mo ON mo.id=selected.option_id::uuid WHERE mo.group_id=_group.id;
      IF _selected_count<GREATEST(_group.min_selections,CASE WHEN _group.required THEN 1 ELSE 0 END)
         OR _selected_count>_group.max_selections THEN
        RAISE EXCEPTION 'Modifier selection does not satisfy its group policy';
      END IF;
    END LOOP;

    _unit_price_fils:=_product.price_fils+_modifier_delta_fils;
    IF _unit_price_fils<0 THEN RAISE EXCEPTION 'Resolved product price cannot be negative'; END IF;
    _line_subtotal_fils:=round(_unit_price_fils::numeric*_quantity)::bigint;
    _line_tax_fils:=round(_line_subtotal_fils::numeric*_product.tax_rate/100)::bigint;
    _line_total_fils:=_line_subtotal_fils+_line_tax_fils;
    INSERT INTO public.table_order_items(tenant_id,order_id,product_id,product_name,product_type,quantity,
      unit_price,tax_rate,discount,line_total,modifiers,status,notes)
    VALUES(_tenant_id,_order.id,_product.id,_product.name,_product.product_type,_quantity,
      public.fils_to_bhd_numeric(_unit_price_fils),_product.tax_rate,0,public.fils_to_bhd_numeric(_line_total_fils),
      _modifier_snapshot,'pending',_notes);
  END LOOP;

  SELECT COALESCE(sum(amounts.subtotal_fils),0)::bigint,
    COALESCE(sum(round(amounts.subtotal_fils::numeric*amounts.tax_rate/100)),0)::bigint
  INTO _order_subtotal_fils,_order_tax_fils
  FROM (SELECT round(public.bhd_numeric_to_fils(i.unit_price)::numeric*i.quantity)::bigint
      - public.bhd_numeric_to_fils(COALESCE(i.discount,0)) subtotal_fils,COALESCE(i.tax_rate,0) tax_rate
    FROM public.table_order_items i WHERE i.order_id=_order.id AND i.status<>'cancelled') amounts;
  IF _order_subtotal_fils<0 OR _order_tax_fils<0 THEN RAISE EXCEPTION 'Table order totals cannot be negative'; END IF;
  UPDATE public.table_orders SET subtotal=public.fils_to_bhd_numeric(_order_subtotal_fils),
    tax_total=public.fils_to_bhd_numeric(_order_tax_fils),
    total=public.fils_to_bhd_numeric(_order_subtotal_fils+_order_tax_fils),updated_at=now()
  WHERE id=_order.id RETURNING * INTO _order;
  UPDATE public.operation_log SET status='success',entity_id=_order.id WHERE id=_journal_id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_user_id,'table_cart.append','table_orders',_order.id,
    jsonb_build_object('branch_id',_branch_id,'table_id',_table_id,'operation_id',_operation_id,'items_count',jsonb_array_length(_items)));
  RETURN _order.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.append_table_cart_v2(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.append_table_cart_v2(uuid,uuid,uuid,text,jsonb) TO authenticated;

COMMIT;
