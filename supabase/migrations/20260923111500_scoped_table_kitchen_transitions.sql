-- P0 restaurant kitchen authority and inventory-effect replay safety.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.start_preparing_table_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_table_item_ready(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dispatch_table_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.undispatch_table_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.send_table_order_to_kitchen(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_table_order_ready(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.apply_table_dispatch_inventory_effect_v2(
  _tenant_id uuid,_branch_id uuid,_product_id uuid,_movement_type public.movement_type,
  _quantity numeric,_reason text,_order_id uuid,_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _center_id uuid;
  _signed numeric;
  _new_quantity numeric;
  _allow_negative boolean;
  _dev_mode boolean;
BEGIN
  IF _movement_type NOT IN ('sale'::public.movement_type,'consumption'::public.movement_type,'return'::public.movement_type)
     OR _quantity IS NULL OR _quantity <= 0 OR _quantity <> round(_quantity,3) THEN
    RAISE EXCEPTION 'Invalid table dispatch inventory effect';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id=_product_id AND tenant_id=_tenant_id) THEN
    RAISE EXCEPTION 'Table dispatch product is outside the authorized tenant scope' USING ERRCODE='42501';
  END IF;
  SELECT id INTO _center_id FROM public.inventory_centers
  WHERE tenant_id=_tenant_id AND branch_id=_branch_id AND status='active'
  ORDER BY (name='Bodega Principal') DESC,created_at LIMIT 1;
  IF _center_id IS NULL THEN RAISE EXCEPTION 'No inventory center found for table dispatch branch'; END IF;
  _signed := CASE WHEN _movement_type='return'::public.movement_type THEN _quantity ELSE -_quantity END;
  SELECT allow_negative_stock,dev_mode INTO _allow_negative,_dev_mode FROM public.tenants WHERE id=_tenant_id;
  INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity)
  VALUES(_tenant_id,_branch_id,_center_id,_product_id,_signed)
  ON CONFLICT(inventory_center_id,product_id) DO UPDATE
  SET quantity=public.inventory_stocks.quantity+EXCLUDED.quantity,updated_at=now()
  RETURNING quantity INTO _new_quantity;
  IF NOT COALESCE(_allow_negative,false) AND NOT COALESCE(_dev_mode,false) AND _new_quantity < 0 THEN
    RAISE EXCEPTION 'Insufficient stock for table dispatch product %',_product_id;
  END IF;
  INSERT INTO public.inventory_movements(
    tenant_id,branch_id,inventory_center_id,product_id,movement_type,quantity,reason,
    reference_type,reference_id,user_id
  ) VALUES(
    _tenant_id,_branch_id,_center_id,_product_id,_movement_type,_quantity,_reason,
    'table_order',_order_id,_user_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_table_dispatch_inventory_effect_v2(
  uuid,uuid,uuid,public.movement_type,numeric,text,uuid,uuid
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.transition_table_item_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _item_id uuid,
  _operation_id text,
  _action text
)
RETURNS public.table_order_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _user_id uuid := auth.uid();
  _item public.table_order_items;
  _order public.table_orders;
  _request jsonb;
  _journal_id uuid;
  _existing public.operation_log;
  _is_elevated boolean;
  _is_waiter boolean;
  _is_kitchen boolean;
  _component record;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  _operation_id := NULLIF(btrim(COALESCE(_operation_id,'')), '');
  _action := lower(NULLIF(btrim(COALESCE(_action,'')), ''));
  IF _operation_id IS NULL OR length(_operation_id) < 8 OR length(_operation_id) > 200 THEN
    RAISE EXCEPTION 'A stable table transition operation ID is required';
  END IF;
  IF _action NOT IN ('start_preparing','mark_ready','dispatch','undispatch') THEN
    RAISE EXCEPTION 'Unsupported table-item transition';
  END IF;

  SELECT * INTO _item FROM public.table_order_items WHERE id=_item_id FOR UPDATE;
  IF NOT FOUND OR _item.tenant_id IS DISTINCT FROM _tenant_id THEN
    RAISE EXCEPTION 'Table item is outside the authorized tenant scope' USING ERRCODE='42501';
  END IF;
  SELECT * INTO _order FROM public.table_orders WHERE id=_item.order_id FOR UPDATE;
  IF NOT FOUND OR _order.tenant_id IS DISTINCT FROM _tenant_id OR _order.branch_id IS DISTINCT FROM _branch_id THEN
    RAISE EXCEPTION 'Table item is outside the authorized branch scope' USING ERRCODE='42501';
  END IF;
  IF _order.status NOT IN ('open'::public.table_order_status,'sent_to_cashier'::public.table_order_status) THEN
    RAISE EXCEPTION 'Table order is not active';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id=_branch_id AND tenant_id=_tenant_id AND status='active') THEN
    RAISE EXCEPTION 'Table order branch is inactive' USING ERRCODE='42501';
  END IF;

  _is_elevated := public.has_branch_role(_user_id,_tenant_id,_branch_id,
    ARRAY['owner','admin','manager','cashier']::public.app_role[]);
  _is_waiter := public.has_branch_role(_user_id,_tenant_id,_branch_id,
    ARRAY['waiter']::public.app_role[]);
  _is_kitchen := public.has_branch_role(_user_id,_tenant_id,_branch_id,
    ARRAY['kitchen']::public.app_role[]);
  IF _action IN ('dispatch','undispatch') THEN
    IF NOT (_is_elevated OR (_is_waiter AND _order.waiter_id IS NOT DISTINCT FROM _user_id)) THEN
      RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
    END IF;
  ELSIF NOT (_is_elevated OR _is_kitchen OR (_is_waiter AND _order.waiter_id IS NOT DISTINCT FROM _user_id)) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
  END IF;

  _request := jsonb_build_object('tenant_id',_tenant_id,'branch_id',_branch_id,
    'item_id',_item_id,'order_id',_order.id,'action',_action);
  INSERT INTO public.operation_log(tenant_id,branch_id,operation_type,client_mutation_id,status,entity_type,payload)
  VALUES(_tenant_id,_branch_id,'transition_table_item_v2',_operation_id,'processing','table_order_items',_request)
  ON CONFLICT (tenant_id,client_mutation_id) DO NOTHING RETURNING id INTO _journal_id;
  IF _journal_id IS NULL THEN
    SELECT * INTO _existing FROM public.operation_log
    WHERE tenant_id=_tenant_id AND client_mutation_id=_operation_id FOR UPDATE;
    IF NOT FOUND OR _existing.branch_id IS DISTINCT FROM _branch_id
       OR _existing.operation_type IS DISTINCT FROM 'transition_table_item_v2'
       OR _existing.payload IS DISTINCT FROM _request THEN
      RAISE EXCEPTION 'Table transition operation ID was already used for a different request';
    END IF;
    IF _existing.status='success' AND _existing.entity_id=_item_id THEN RETURN _item; END IF;
    RAISE EXCEPTION 'Table transition operation is already processing';
  END IF;

  CASE _action
    WHEN 'start_preparing' THEN SELECT * INTO _item FROM public.start_preparing_table_item(_item_id);
    WHEN 'mark_ready' THEN SELECT * INTO _item FROM public.mark_table_item_ready(_item_id);
    WHEN 'dispatch' THEN
      IF _item.status='cancelled' THEN RAISE EXCEPTION 'Table item is cancelled'; END IF;
      IF _item.status<>'dispatched' THEN
        IF _item.product_type IN ('simple','production','combo') THEN
          PERFORM public.apply_table_dispatch_inventory_effect_v2(
            _tenant_id,_branch_id,_item.product_id,'sale'::public.movement_type,_item.quantity,
            'Table dispatch',_order.id,_user_id);
        ELSIF _item.product_type='composite' THEN
          FOR _component IN SELECT component_product_id,quantity,COALESCE(waste_pct,0) waste_pct
            FROM public.product_components WHERE parent_product_id=_item.product_id LOOP
            PERFORM public.apply_table_dispatch_inventory_effect_v2(
              _tenant_id,_branch_id,_component.component_product_id,'consumption'::public.movement_type,
              round(_component.quantity*_item.quantity*(1+_component.waste_pct/100.0),3),
              'Table dispatch composite',_order.id,_user_id);
          END LOOP;
        END IF;
        UPDATE public.table_order_items SET status='dispatched',dispatched_at=now(),dispatched_by=_user_id
        WHERE id=_item_id RETURNING * INTO _item;
      END IF;
    WHEN 'undispatch' THEN
      IF _item.status='dispatched' THEN
        IF _item.product_type IN ('simple','production','combo') THEN
          PERFORM public.apply_table_dispatch_inventory_effect_v2(
            _tenant_id,_branch_id,_item.product_id,'return'::public.movement_type,_item.quantity,
            'Table undispatch',_order.id,_user_id);
        ELSIF _item.product_type='composite' THEN
          FOR _component IN SELECT component_product_id,quantity,COALESCE(waste_pct,0) waste_pct
            FROM public.product_components WHERE parent_product_id=_item.product_id LOOP
            PERFORM public.apply_table_dispatch_inventory_effect_v2(
              _tenant_id,_branch_id,_component.component_product_id,'return'::public.movement_type,
              round(_component.quantity*_item.quantity*(1+_component.waste_pct/100.0),3),
              'Table undispatch composite',_order.id,_user_id);
          END LOOP;
        END IF;
        UPDATE public.table_order_items SET status='pending',dispatched_at=NULL,dispatched_by=NULL
        WHERE id=_item_id RETURNING * INTO _item;
      END IF;
  END CASE;
  UPDATE public.operation_log SET status='success',entity_id=_item_id WHERE id=_journal_id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_user_id,'table_item_transition.'||_action,'table_order_items',_item_id,
    jsonb_build_object('branch_id',_branch_id,'order_id',_order.id,'operation_id',_operation_id));
  RETURN _item;
END;
$function$;

CREATE OR REPLACE FUNCTION public.transition_table_order_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _order_id uuid,
  _operation_id text,
  _action text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _user_id uuid := auth.uid();
  _order public.table_orders;
  _request jsonb;
  _journal_id uuid;
  _existing public.operation_log;
  _affected integer;
  _is_elevated boolean;
  _is_waiter boolean;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  _operation_id := NULLIF(btrim(COALESCE(_operation_id,'')), '');
  _action := lower(NULLIF(btrim(COALESCE(_action,'')), ''));
  IF _operation_id IS NULL OR length(_operation_id) < 8 OR length(_operation_id) > 200 THEN
    RAISE EXCEPTION 'A stable table transition operation ID is required';
  END IF;
  IF _action NOT IN ('send_to_kitchen','mark_ready') THEN RAISE EXCEPTION 'Unsupported table-order transition'; END IF;
  SELECT * INTO _order FROM public.table_orders WHERE id=_order_id FOR UPDATE;
  IF NOT FOUND OR _order.tenant_id IS DISTINCT FROM _tenant_id OR _order.branch_id IS DISTINCT FROM _branch_id THEN
    RAISE EXCEPTION 'Table order is outside the authorized branch scope' USING ERRCODE='42501';
  END IF;
  IF _order.status NOT IN ('open'::public.table_order_status,'sent_to_cashier'::public.table_order_status) THEN
    RAISE EXCEPTION 'Table order is not active';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id=_branch_id AND tenant_id=_tenant_id AND status='active') THEN
    RAISE EXCEPTION 'Table order branch is inactive' USING ERRCODE='42501';
  END IF;
  _is_elevated := public.has_branch_role(_user_id,_tenant_id,_branch_id,
    ARRAY['owner','admin','manager','cashier','kitchen']::public.app_role[]);
  _is_waiter := public.has_branch_role(_user_id,_tenant_id,_branch_id,ARRAY['waiter']::public.app_role[]);
  IF NOT (_is_elevated OR (_is_waiter AND _order.waiter_id IS NOT DISTINCT FROM _user_id)) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
  END IF;
  _request := jsonb_build_object('tenant_id',_tenant_id,'branch_id',_branch_id,'order_id',_order_id,'action',_action);
  INSERT INTO public.operation_log(tenant_id,branch_id,operation_type,client_mutation_id,status,entity_type,payload)
  VALUES(_tenant_id,_branch_id,'transition_table_order_v2',_operation_id,'processing','table_orders',_request)
  ON CONFLICT (tenant_id,client_mutation_id) DO NOTHING RETURNING id INTO _journal_id;
  IF _journal_id IS NULL THEN
    SELECT * INTO _existing FROM public.operation_log
    WHERE tenant_id=_tenant_id AND client_mutation_id=_operation_id FOR UPDATE;
    IF NOT FOUND OR _existing.branch_id IS DISTINCT FROM _branch_id
       OR _existing.operation_type IS DISTINCT FROM 'transition_table_order_v2'
       OR (_existing.payload - 'result_count') IS DISTINCT FROM _request THEN
      RAISE EXCEPTION 'Table transition operation ID was already used for a different request';
    END IF;
    IF _existing.status='success' THEN RETURN COALESCE((_existing.payload->>'result_count')::integer,0); END IF;
    RAISE EXCEPTION 'Table transition operation is already processing';
  END IF;
  IF _action='send_to_kitchen' THEN
    _affected := public.send_table_order_to_kitchen(_order_id);
  ELSE
    _affected := public.mark_table_order_ready(_order_id);
  END IF;
  UPDATE public.operation_log SET status='success',entity_id=_order_id,
    payload=_request||jsonb_build_object('result_count',_affected) WHERE id=_journal_id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_user_id,'table_order_transition.'||_action,'table_orders',_order_id,
    jsonb_build_object('branch_id',_branch_id,'operation_id',_operation_id,'affected_items',_affected));
  RETURN _affected;
END;
$function$;

REVOKE ALL ON FUNCTION public.transition_table_item_v2(uuid,uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_table_item_v2(uuid,uuid,uuid,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.transition_table_order_v2(uuid,uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_table_order_v2(uuid,uuid,uuid,text,text) TO authenticated;

COMMIT;
