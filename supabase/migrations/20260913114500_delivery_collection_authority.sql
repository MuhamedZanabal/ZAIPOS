BEGIN;

-- Fees remain separate from merchandise sales: never inflate sale payments or
-- rewrite historical sale VAT. The collection record preserves both components.
CREATE TABLE public.delivery_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  order_id uuid NOT NULL UNIQUE REFERENCES public.delivery_orders(id) ON DELETE RESTRICT,
  sale_id uuid NOT NULL UNIQUE REFERENCES public.sales(id) ON DELETE RESTRICT,
  payment_id uuid UNIQUE REFERENCES public.payments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES public.cash_sessions(id) ON DELETE RESTRICT,
  client_mutation_id text NOT NULL,
  request_payload jsonb NOT NULL,
  method public.payment_method NOT NULL,
  sale_amount_fils bigint NOT NULL CHECK (sale_amount_fils >= 0),
  fee_amount_fils bigint NOT NULL CHECK (fee_amount_fils >= 0),
  collected_fils bigint NOT NULL CHECK (collected_fils > 0),
  reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_mutation_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES public.branches(tenant_id,id),
  CHECK (collected_fils = sale_amount_fils + fee_amount_fils),
  CHECK ((sale_amount_fils > 0) = (payment_id IS NOT NULL))
);
ALTER TABLE public.delivery_collections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.delivery_collections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.delivery_collections TO authenticated;
CREATE POLICY delivery_collections_scoped_read ON public.delivery_collections
FOR SELECT TO authenticated USING (
  public.has_branch_role(auth.uid(),tenant_id,branch_id,ARRAY['owner','admin','manager','cashier']::public.app_role[])
  OR (user_id=auth.uid() AND public.has_branch_role(auth.uid(),tenant_id,branch_id,ARRAY['courier']::public.app_role[]))
);

-- App clients cannot change fees, sale links, assignment or completion evidence.
REVOKE ALL ON public.delivery_orders FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.delivery_orders FROM authenticated;
DROP POLICY IF EXISTS delivery_orders_member_all ON public.delivery_orders;
DROP POLICY IF EXISTS delivery_orders_member_select ON public.delivery_orders;
CREATE POLICY delivery_orders_scoped_read ON public.delivery_orders FOR SELECT TO authenticated
USING (
  public.has_branch_role(auth.uid(),tenant_id,branch_id,ARRAY['owner','admin','manager','cashier','waiter']::public.app_role[])
  OR (public.has_branch_role(auth.uid(),tenant_id,branch_id,ARRAY['courier']::public.app_role[]) AND EXISTS (
    SELECT 1 FROM public.employees e WHERE e.id=courier_id AND e.user_id=auth.uid()
      AND e.tenant_id=delivery_orders.tenant_id AND (e.branch_id IS NULL OR e.branch_id=delivery_orders.branch_id) AND e.status='active'
  ))
);
REVOKE ALL ON FUNCTION public.register_delivery_payment(uuid,public.payment_method,numeric,text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.collect_delivery_payment_v2(
  _order_id uuid, _method public.payment_method, _session_id uuid,
  _client_mutation_id text, _reference text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _o public.delivery_orders;
  _s public.sales;
  _prior public.delivery_collections;
  _payment_id uuid;
  _id uuid;
  _payload jsonb;
  _total bigint;
  _manager boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _method IS NULL OR _method NOT IN ('cash','card','transfer','qr') THEN RAISE EXCEPTION 'Unsupported collection method'; END IF;
  IF _client_mutation_id IS NULL OR length(btrim(_client_mutation_id)) < 8 OR length(_client_mutation_id)>200 THEN RAISE EXCEPTION 'Stable collection operation ID required'; END IF;
  IF length(COALESCE(_reference,''))>200 THEN RAISE EXCEPTION 'Collection reference too long'; END IF;
  SELECT * INTO _o FROM public.delivery_orders WHERE id=_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;
  _manager := public.has_branch_role(auth.uid(),_o.tenant_id,_o.branch_id,ARRAY['owner','admin','manager','cashier']::public.app_role[]);
  IF NOT _manager AND NOT (
    public.has_branch_role(auth.uid(),_o.tenant_id,_o.branch_id,ARRAY['courier']::public.app_role[])
    AND EXISTS (SELECT 1 FROM public.employees WHERE id=_o.courier_id AND user_id=auth.uid() AND tenant_id=_o.tenant_id
      AND (branch_id IS NULL OR branch_id=_o.branch_id) AND status='active')
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  _payload := jsonb_build_object('order_id',_order_id,'method',_method,'session_id',_session_id,'reference',_reference);
  SELECT * INTO _prior FROM public.delivery_collections WHERE tenant_id=_o.tenant_id AND client_mutation_id=_client_mutation_id;
  IF FOUND THEN
    IF _prior.user_id<>auth.uid() OR _prior.request_payload IS DISTINCT FROM _payload THEN RAISE EXCEPTION 'Collection operation payload mismatch'; END IF;
    RETURN _prior.id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_collections WHERE order_id=_order_id) THEN RAISE EXCEPTION 'Delivery already collected'; END IF;
  IF _o.status NOT IN ('on_way','assigned','ready') THEN RAISE EXCEPTION 'Delivery is not ready for collection'; END IF;
  SELECT * INTO _s FROM public.sales WHERE id=_o.sale_id FOR UPDATE;
  IF NOT FOUND OR _s.tenant_id<>_o.tenant_id OR _s.branch_id<>_o.branch_id OR _s.channel<>'delivery' OR _s.status<>'completed' THEN RAISE EXCEPTION 'Invalid delivery sale authority'; END IF;
  -- Legacy partial/full collections need reconciliation, never an inferred top-up.
  IF EXISTS (SELECT 1 FROM public.payments WHERE sale_id=_s.id) THEN RAISE EXCEPTION 'Existing payment requires reconciliation'; END IF;
  IF _o.delivery_fee_fils IS NULL OR _o.delivery_fee_fils<0 OR _o.delivery_fee<>public.fils_to_bhd_numeric(_o.delivery_fee_fils) THEN RAISE EXCEPTION 'Delivery fee evidence mismatch'; END IF;
  IF _s.total_fils IS NULL OR _s.total_fils<0 THEN RAISE EXCEPTION 'Invalid sale total'; END IF;
  _total:=_s.total_fils+_o.delivery_fee_fils;
  IF _total<=0 THEN RAISE EXCEPTION 'No amount due'; END IF;
  -- Explicit receiving register; never pick the latest arbitrary open drawer.
  PERFORM 1 FROM public.cash_sessions WHERE id=_session_id AND tenant_id=_o.tenant_id AND branch_id=_o.branch_id AND status='open' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exact open receiving cash session required'; END IF;
  IF _s.session_id IS NOT NULL AND _s.session_id<>_session_id THEN RAISE EXCEPTION 'Sale already belongs to another cash session'; END IF;
  IF _s.total_fils>0 THEN
    INSERT INTO public.payments(tenant_id,sale_id,method,amount,amount_fils,reference)
    VALUES(_o.tenant_id,_s.id,_method,public.fils_to_bhd_numeric(_s.total_fils),_s.total_fils,_reference) RETURNING id INTO _payment_id;
  END IF;
  INSERT INTO public.delivery_collections(tenant_id,branch_id,order_id,sale_id,payment_id,user_id,session_id,client_mutation_id,request_payload,method,sale_amount_fils,fee_amount_fils,collected_fils,reference)
  VALUES(_o.tenant_id,_o.branch_id,_o.id,_s.id,_payment_id,auth.uid(),_session_id,_client_mutation_id,_payload,_method,_s.total_fils,_o.delivery_fee_fils,_total,_reference) RETURNING id INTO _id;
  UPDATE public.cash_sessions SET
    total_cash=public.fils_to_bhd_numeric(total_cash_fils+CASE WHEN _method='cash' THEN _total ELSE 0 END),
    total_card=public.fils_to_bhd_numeric(total_card_fils+CASE WHEN _method='card' THEN _total ELSE 0 END),
    total_transfer=public.fils_to_bhd_numeric(total_transfer_fils+CASE WHEN _method='transfer' THEN _total ELSE 0 END),
    total_qr=public.fils_to_bhd_numeric(total_qr_fils+CASE WHEN _method='qr' THEN _total ELSE 0 END)
  WHERE id=_session_id;
  UPDATE public.sales SET session_id=_session_id WHERE id=_s.id;
  UPDATE public.delivery_orders SET status='delivered',delivered_at=now() WHERE id=_o.id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_o.tenant_id,auth.uid(),'delivery.collected_v2','delivery_collections',_id,
    jsonb_build_object('order_id',_o.id,'sale_id',_s.id,'session_id',_session_id,'operation_id',_client_mutation_id,'sale_amount_fils',_s.total_fils,'fee_amount_fils',_o.delivery_fee_fils,'collected_fils',_total,'method',_method));
  RETURN _id;
END; $$;
REVOKE ALL ON FUNCTION public.collect_delivery_payment_v2(uuid,public.payment_method,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collect_delivery_payment_v2(uuid,public.payment_method,uuid,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_delivery_status(_order_id uuid,_status public.delivery_status,_courier_id uuid DEFAULT NULL)
RETURNS public.delivery_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE _o public.delivery_orders; _manager boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO _o FROM public.delivery_orders WHERE id=_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;
  _manager:=public.has_branch_role(auth.uid(),_o.tenant_id,_o.branch_id,ARRAY['owner','admin','manager','cashier','waiter']::public.app_role[]);
  IF NOT _manager AND NOT (
    _courier_id IS NULL AND _status='on_way' AND public.has_branch_role(auth.uid(),_o.tenant_id,_o.branch_id,ARRAY['courier']::public.app_role[])
    AND EXISTS (SELECT 1 FROM public.employees WHERE id=_o.courier_id AND user_id=auth.uid() AND tenant_id=_o.tenant_id AND (branch_id IS NULL OR branch_id=_o.branch_id) AND status='active')
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF _status='delivered' THEN RAISE EXCEPTION 'Use atomic delivery collection'; END IF;
  IF _o.status IN ('delivered','cancelled') THEN RAISE EXCEPTION 'Delivery is already final'; END IF;
  IF _status IS NULL THEN RAISE EXCEPTION 'Delivery status required'; END IF;
  IF _status='cancelled' AND NOT EXISTS (SELECT 1 FROM public.sales WHERE id=_o.sale_id AND tenant_id=_o.tenant_id AND branch_id=_o.branch_id AND status='cancelled') THEN
    RAISE EXCEPTION 'Void the authoritative sale before cancelling delivery';
  END IF;
  IF _courier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id=_courier_id AND e.tenant_id=_o.tenant_id AND (e.branch_id IS NULL OR e.branch_id=_o.branch_id) AND e.status='active'
    AND public.has_branch_role(e.user_id,_o.tenant_id,_o.branch_id,ARRAY['courier']::public.app_role[])) THEN RAISE EXCEPTION 'Courier must be active and authorized for this branch'; END IF;
  UPDATE public.delivery_orders SET status=_status,courier_id=COALESCE(_courier_id,courier_id),assigned_at=CASE WHEN _status='assigned' THEN COALESCE(assigned_at,now()) ELSE assigned_at END WHERE id=_o.id RETURNING * INTO _o;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_o.tenant_id,auth.uid(),'delivery.status_changed','delivery_orders',_o.id,jsonb_build_object('status',_status,'courier_id',_o.courier_id));
  RETURN _o;
END; $$;
REVOKE ALL ON FUNCTION public.update_delivery_status(uuid,public.delivery_status,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_delivery_status(uuid,public.delivery_status,uuid) TO authenticated;
-- Narrow read model: no reliance on nonexistent legacy sale FK/PostgREST join,
-- and couriers never receive another courier's customer details or till totals.
CREATE FUNCTION public.list_courier_deliveries(_tenant_id uuid,_branch_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE _manager boolean; _orders jsonb; _sessions jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  _manager:=public.has_branch_role(auth.uid(),_tenant_id,_branch_id,ARRAY['owner','admin','manager','cashier']::public.app_role[]);
  IF NOT _manager AND NOT public.has_branch_role(auth.uid(),_tenant_id,_branch_id,ARRAY['courier']::public.app_role[]) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC),'[]'::jsonb) INTO _orders FROM (
    SELECT o.id,o.status,o.customer_name,o.customer_phone,o.address,o.neighborhood,o.delivered_at,o.updated_at,o.created_at,
      (s.total_fils+o.delivery_fee_fils)::text AS collection_total_fils,
      c.id AS collection_id
    FROM public.delivery_orders o
    LEFT JOIN public.sales s ON s.id=o.sale_id AND s.tenant_id=o.tenant_id AND s.branch_id=o.branch_id
    LEFT JOIN public.delivery_collections c ON c.order_id=o.id
    WHERE o.tenant_id=_tenant_id AND o.branch_id=_branch_id AND (
      _manager OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id=o.courier_id AND e.user_id=auth.uid()
        AND e.tenant_id=_tenant_id AND (e.branch_id IS NULL OR e.branch_id=_branch_id) AND e.status='active')
    ) ORDER BY o.created_at DESC LIMIT 100
  ) q;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'opened_at',c.opened_at,'register_name',COALESCE(r.name,'Register')) ORDER BY c.opened_at),'[]'::jsonb)
  INTO _sessions FROM public.cash_sessions c LEFT JOIN public.cash_registers r ON r.id=c.register_id AND r.tenant_id=c.tenant_id
  WHERE c.tenant_id=_tenant_id AND c.branch_id=_branch_id AND c.status='open';
  RETURN jsonb_build_object('orders',_orders,'sessions',_sessions,'limit',100);
END; $$;
REVOKE ALL ON FUNCTION public.list_courier_deliveries(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.list_courier_deliveries(uuid,uuid) TO authenticated;
COMMIT;
