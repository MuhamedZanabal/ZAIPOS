-- P0 table-order creation authority. Direct authenticated INSERT is replaced
-- by a locked, branch/role-scoped and replay-safe order-opening command.

BEGIN;

DROP POLICY IF EXISTS table_orders_member_insert ON public.table_orders;
REVOKE INSERT ON public.table_orders FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.open_table_order_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _table_id uuid,
  _operation_id text
)
RETURNS public.table_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $function$
DECLARE
  _user_id uuid:=auth.uid();
  _table public.tables;
  _order public.table_orders;
  _request jsonb;
  _journal_id uuid;
  _existing public.operation_log;
  _is_elevated boolean;
  _is_waiter boolean;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  _operation_id:=NULLIF(btrim(COALESCE(_operation_id,'')),'');
  IF _operation_id IS NULL OR length(_operation_id)<8 OR length(_operation_id)>200 THEN
    RAISE EXCEPTION 'A stable table-order opening operation ID is required';
  END IF;

  SELECT * INTO _table FROM public.tables WHERE id=_table_id FOR UPDATE;
  IF NOT FOUND OR _table.tenant_id IS DISTINCT FROM _tenant_id OR _table.branch_id IS DISTINCT FROM _branch_id THEN
    RAISE EXCEPTION 'Table is outside the authorized branch scope' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.branches WHERE id=_branch_id AND tenant_id=_tenant_id AND status='active') THEN
    RAISE EXCEPTION 'Table branch is inactive' USING ERRCODE='42501';
  END IF;

  _is_elevated:=public.has_branch_role(_user_id,_tenant_id,_branch_id,
    ARRAY['owner','admin','manager','cashier']::public.app_role[]);
  _is_waiter:=public.has_branch_role(_user_id,_tenant_id,_branch_id,ARRAY['waiter']::public.app_role[]);
  IF NOT (_is_elevated OR (_is_waiter AND (_table.assigned_waiter_id IS NULL OR _table.assigned_waiter_id=_user_id))) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
  END IF;

  _request:=jsonb_build_object('tenant_id',_tenant_id,'branch_id',_branch_id,'table_id',_table_id);
  INSERT INTO public.operation_log(tenant_id,branch_id,operation_type,client_mutation_id,status,entity_type,payload)
  VALUES(_tenant_id,_branch_id,'open_table_order_v2',_operation_id,'processing','table_orders',_request)
  ON CONFLICT(tenant_id,client_mutation_id) DO NOTHING RETURNING id INTO _journal_id;
  IF _journal_id IS NULL THEN
    SELECT * INTO _existing FROM public.operation_log
    WHERE tenant_id=_tenant_id AND client_mutation_id=_operation_id FOR UPDATE;
    IF NOT FOUND OR _existing.branch_id IS DISTINCT FROM _branch_id
       OR _existing.operation_type IS DISTINCT FROM 'open_table_order_v2'
       OR _existing.payload IS DISTINCT FROM _request THEN
      RAISE EXCEPTION 'Table-order opening operation ID was already used for a different request';
    END IF;
    IF _existing.status='success' AND _existing.entity_id IS NOT NULL THEN
      SELECT * INTO _order FROM public.table_orders WHERE id=_existing.entity_id;
      IF FOUND THEN RETURN _order; END IF;
    END IF;
    RAISE EXCEPTION 'Table-order opening operation is already processing';
  END IF;

  IF EXISTS(SELECT 1 FROM public.table_orders WHERE table_id=_table_id AND status='sent_to_cashier') THEN
    RAISE EXCEPTION 'Table has an order pending payment';
  END IF;
  SELECT * INTO _order FROM public.table_orders
  WHERE table_id=_table_id AND status='open' ORDER BY opened_at DESC,id LIMIT 1;
  IF FOUND AND _is_waiter AND _order.waiter_id IS DISTINCT FROM _user_id THEN
    RAISE EXCEPTION 'Table order is assigned to another waiter' USING ERRCODE='42501';
  END IF;
  IF NOT FOUND THEN
    IF _table.status IS DISTINCT FROM 'available'::public.table_status THEN
      RAISE EXCEPTION 'Table is not available';
    END IF;
    INSERT INTO public.table_orders(tenant_id,branch_id,table_id,waiter_id,status)
    VALUES(_tenant_id,_branch_id,_table_id,_user_id,'open') RETURNING * INTO _order;
    IF _is_waiter AND _table.assigned_waiter_id IS NULL THEN
      UPDATE public.tables SET assigned_waiter_id=_user_id WHERE id=_table_id;
    END IF;
  END IF;

  UPDATE public.operation_log SET status='success',entity_id=_order.id WHERE id=_journal_id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_user_id,'table_order.open','table_orders',_order.id,
    jsonb_build_object('branch_id',_branch_id,'table_id',_table_id,'operation_id',_operation_id));
  RETURN _order;
END;
$function$;

REVOKE ALL ON FUNCTION public.open_table_order_v2(uuid,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_table_order_v2(uuid,uuid,uuid,text) TO authenticated;

COMMIT;
