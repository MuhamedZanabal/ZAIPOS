-- P0 table-order lifecycle authority. Renderer status writes and the legacy
-- send-to-cashier RPC are replaced by one locked, replay-safe command.

BEGIN;

DROP POLICY IF EXISTS table_orders_member_all ON public.table_orders;
REVOKE UPDATE, DELETE ON public.table_orders FROM PUBLIC, anon, authenticated;
CREATE POLICY table_orders_member_insert ON public.table_orders
FOR INSERT TO authenticated
WITH CHECK (public.is_tenant_member(auth.uid(),tenant_id));
REVOKE EXECUTE ON FUNCTION public.send_table_order_to_cashier(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.transition_table_order_lifecycle_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _order_id uuid,
  _operation_id text,
  _action text
)
RETURNS public.table_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $function$
DECLARE
  _user_id uuid:=auth.uid();
  _order public.table_orders;
  _item record;
  _request jsonb;
  _journal_id uuid;
  _existing public.operation_log;
  _is_elevated boolean;
  _is_waiter boolean;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  _operation_id:=NULLIF(btrim(COALESCE(_operation_id,'')),'');
  _action:=lower(NULLIF(btrim(COALESCE(_action,'')),''));
  IF _operation_id IS NULL OR length(_operation_id)<8 OR length(_operation_id)>200 THEN
    RAISE EXCEPTION 'A stable table-order lifecycle operation ID is required';
  END IF;
  IF _action NOT IN ('send_to_cashier','cancel') THEN RAISE EXCEPTION 'Unsupported table-order lifecycle action'; END IF;

  SELECT * INTO _order FROM public.table_orders WHERE id=_order_id;
  IF NOT FOUND OR _order.tenant_id IS DISTINCT FROM _tenant_id OR _order.branch_id IS DISTINCT FROM _branch_id THEN
    RAISE EXCEPTION 'Table order is outside the authorized branch scope' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.branches WHERE id=_branch_id AND tenant_id=_tenant_id AND status='active') THEN
    RAISE EXCEPTION 'Table order branch is inactive' USING ERRCODE='42501';
  END IF;
  _is_elevated:=public.has_branch_role(_user_id,_tenant_id,_branch_id,
    CASE WHEN _action='cancel'
      THEN ARRAY['owner','admin','manager']::public.app_role[]
      ELSE ARRAY['owner','admin','manager','cashier']::public.app_role[] END);
  _is_waiter:=public.has_branch_role(_user_id,_tenant_id,_branch_id,ARRAY['waiter']::public.app_role[]);
  IF NOT (_is_elevated OR (_is_waiter AND _order.waiter_id IS NOT DISTINCT FROM _user_id)) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
  END IF;

  -- Item transitions lock item then order. Match that ordering for cancellation
  -- so concurrent dispatch/cancel operations serialize without a lock cycle.
  IF _action='cancel' THEN
    PERFORM 1 FROM public.table_order_items
    WHERE order_id=_order_id ORDER BY id FOR UPDATE;
  END IF;
  SELECT * INTO _order FROM public.table_orders WHERE id=_order_id FOR UPDATE;
  IF NOT FOUND OR _order.tenant_id IS DISTINCT FROM _tenant_id OR _order.branch_id IS DISTINCT FROM _branch_id THEN
    RAISE EXCEPTION 'Table order is outside the authorized branch scope' USING ERRCODE='42501';
  END IF;
  _is_elevated:=public.has_branch_role(_user_id,_tenant_id,_branch_id,
    CASE WHEN _action='cancel'
      THEN ARRAY['owner','admin','manager']::public.app_role[]
      ELSE ARRAY['owner','admin','manager','cashier']::public.app_role[] END);
  _is_waiter:=public.has_branch_role(_user_id,_tenant_id,_branch_id,ARRAY['waiter']::public.app_role[]);
  IF NOT (_is_elevated OR (_is_waiter AND _order.waiter_id IS NOT DISTINCT FROM _user_id)) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
  END IF;

  _request:=jsonb_build_object('tenant_id',_tenant_id,'branch_id',_branch_id,'order_id',_order_id,'action',_action);
  INSERT INTO public.operation_log(tenant_id,branch_id,operation_type,client_mutation_id,status,entity_type,payload)
  VALUES(_tenant_id,_branch_id,'transition_table_order_lifecycle_v2',_operation_id,'processing','table_orders',_request)
  ON CONFLICT(tenant_id,client_mutation_id) DO NOTHING RETURNING id INTO _journal_id;
  IF _journal_id IS NULL THEN
    SELECT * INTO _existing FROM public.operation_log
    WHERE tenant_id=_tenant_id AND client_mutation_id=_operation_id FOR UPDATE;
    IF NOT FOUND OR _existing.branch_id IS DISTINCT FROM _branch_id
       OR _existing.operation_type IS DISTINCT FROM 'transition_table_order_lifecycle_v2'
       OR _existing.payload IS DISTINCT FROM _request THEN
      RAISE EXCEPTION 'Table-order lifecycle operation ID was already used for a different request';
    END IF;
    IF _existing.status='success' AND _existing.entity_id=_order_id THEN RETURN _order; END IF;
    RAISE EXCEPTION 'Table-order lifecycle operation is already processing';
  END IF;

  IF _action='send_to_cashier' THEN
    IF _order.status<>'open'::public.table_order_status THEN RAISE EXCEPTION 'Table order is not open'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.table_order_items WHERE order_id=_order_id AND status<>'cancelled') THEN
      RAISE EXCEPTION 'Table order has no active items';
    END IF;
    PERFORM public.recalc_table_order(_order_id);
    UPDATE public.table_orders SET status='sent_to_cashier',sent_at=COALESCE(sent_at,now()),updated_at=now()
    WHERE id=_order_id RETURNING * INTO _order;
  ELSE
    IF _order.status NOT IN ('open'::public.table_order_status,'sent_to_cashier'::public.table_order_status) THEN
      RAISE EXCEPTION 'Only an active table order can be cancelled';
    END IF;
    FOR _item IN SELECT id FROM public.table_order_items WHERE order_id=_order_id AND status='dispatched' ORDER BY id LOOP
      PERFORM public.transition_table_item_v2(
        _tenant_id,_branch_id,_item.id,'cancel-item:'||md5(_operation_id||':'||_item.id::text),'undispatch');
    END LOOP;
    UPDATE public.table_order_items SET status='cancelled'
    WHERE order_id=_order_id AND status<>'dispatched';
    UPDATE public.table_orders SET status='cancelled',closed_at=COALESCE(closed_at,now()),updated_at=now()
    WHERE id=_order_id RETURNING * INTO _order;
  END IF;

  UPDATE public.operation_log SET status='success',entity_id=_order_id WHERE id=_journal_id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_user_id,'table_order_lifecycle.'||_action,'table_orders',_order_id,
    jsonb_build_object('branch_id',_branch_id,'operation_id',_operation_id));
  RETURN _order;
END;
$function$;

REVOKE ALL ON FUNCTION public.transition_table_order_lifecycle_v2(uuid,uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_table_order_lifecycle_v2(uuid,uuid,uuid,text,text) TO authenticated;

COMMIT;
