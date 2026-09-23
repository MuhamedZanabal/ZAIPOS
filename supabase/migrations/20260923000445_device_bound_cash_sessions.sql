-- P0: opening floats and final register counts are financial authority. Bind
-- them to the native-held terminal credential and an immutable operation ID.
BEGIN;

CREATE TABLE public.cash_session_device_operations (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  operation_id text NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('open','close')),
  request_payload jsonb NOT NULL,
  session_id uuid REFERENCES public.cash_sessions(id),
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, operation_id),
  CHECK (length(operation_id) BETWEEN 8 AND 200)
);
ALTER TABLE public.cash_session_device_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cash_session_device_operations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.open_cash_session_v2_device(
  _tenant_id uuid, _branch_id uuid, _opening_amount numeric,
  _register_id uuid, _operation_id text, _device_uid text, _device_credential text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  _request jsonb;
  _operation public.cash_session_device_operations;
  _session public.cash_sessions;
  _opening_fils bigint;
BEGIN
  PERFORM public.require_financial_device_v1(_tenant_id,_branch_id,_device_uid,_device_credential);
  IF _operation_id IS NULL OR length(btrim(_operation_id)) < 8 OR length(_operation_id) > 200 OR _operation_id <> btrim(_operation_id) THEN
    RAISE EXCEPTION 'Cash-session operation ID required';
  END IF;
  IF _opening_amount IS NULL OR _opening_amount < 0 OR _opening_amount <> round(_opening_amount,3)
     OR _opening_amount::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Opening cash requires an explicit non-negative exact-fils amount';
  END IF;
  _opening_fils := public.bhd_numeric_to_fils(_opening_amount);
  _request := jsonb_build_object('opening_amount_fils',_opening_fils,'register_id',_register_id);

  INSERT INTO public.cash_session_device_operations(tenant_id,branch_id,operation_id,operation_type,request_payload,actor_id)
  VALUES(_tenant_id,_branch_id,_operation_id,'open',_request,auth.uid()) ON CONFLICT DO NOTHING;
  SELECT * INTO _operation FROM public.cash_session_device_operations
   WHERE tenant_id=_tenant_id AND operation_id=_operation_id FOR UPDATE;
  IF _operation.branch_id IS DISTINCT FROM _branch_id OR _operation.operation_type <> 'open'
     OR _operation.request_payload <> _request OR _operation.actor_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Cash-session operation ID conflicts with a different request' USING ERRCODE='23505';
  END IF;
  IF _operation.session_id IS NOT NULL THEN RETURN _operation.session_id; END IF;

  _session := public.open_cash_session(_tenant_id,_branch_id,_opening_amount,_register_id);
  UPDATE public.cash_session_device_operations SET session_id=_session.id,completed_at=now()
   WHERE tenant_id=_tenant_id AND operation_id=_operation_id;
  RETURN _session.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.close_cash_session_v2_device(
  _tenant_id uuid, _branch_id uuid, _session_id uuid,
  _counted_amount numeric, _notes text, _counted_card numeric,
  _counted_transfer numeric, _counted_qr numeric, _operation_id text,
  _device_uid text, _device_credential text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  _request jsonb;
  _operation public.cash_session_device_operations;
  _session public.cash_sessions;
BEGIN
  PERFORM public.require_financial_device_v1(_tenant_id,_branch_id,_device_uid,_device_credential);
  IF _operation_id IS NULL OR length(btrim(_operation_id)) < 8 OR length(_operation_id) > 200 OR _operation_id <> btrim(_operation_id) THEN
    RAISE EXCEPTION 'Cash-session operation ID required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.cash_sessions s WHERE s.id=_session_id AND s.tenant_id=_tenant_id AND s.branch_id=_branch_id) THEN
    RAISE EXCEPTION 'Cash session scope mismatch' USING ERRCODE='42501';
  END IF;
  IF _counted_amount IS NULL OR _counted_card IS NULL OR _counted_transfer IS NULL OR _counted_qr IS NULL
     OR _counted_amount::text IN ('NaN','Infinity','-Infinity')
     OR _counted_card::text IN ('NaN','Infinity','-Infinity')
     OR _counted_transfer::text IN ('NaN','Infinity','-Infinity')
     OR _counted_qr::text IN ('NaN','Infinity','-Infinity')
     OR _counted_amount < 0 OR _counted_card < 0 OR _counted_transfer < 0 OR _counted_qr < 0
     OR _counted_amount <> round(_counted_amount,3) OR _counted_card <> round(_counted_card,3)
     OR _counted_transfer <> round(_counted_transfer,3) OR _counted_qr <> round(_counted_qr,3) THEN
    RAISE EXCEPTION 'Closing counts require explicit non-negative exact-fils amounts';
  END IF;
  IF length(coalesce(_notes,'')) > 2000 THEN RAISE EXCEPTION 'Closing notes are too long'; END IF;
  _request := jsonb_build_object(
    'session_id',_session_id,'counted_cash_fils',public.bhd_numeric_to_fils(_counted_amount),
    'counted_card_fils',public.bhd_numeric_to_fils(_counted_card),
    'counted_transfer_fils',public.bhd_numeric_to_fils(_counted_transfer),
    'counted_qr_fils',public.bhd_numeric_to_fils(_counted_qr),'notes',_notes
  );

  INSERT INTO public.cash_session_device_operations(tenant_id,branch_id,operation_id,operation_type,request_payload,actor_id)
  VALUES(_tenant_id,_branch_id,_operation_id,'close',_request,auth.uid()) ON CONFLICT DO NOTHING;
  SELECT * INTO _operation FROM public.cash_session_device_operations
   WHERE tenant_id=_tenant_id AND operation_id=_operation_id FOR UPDATE;
  IF _operation.branch_id IS DISTINCT FROM _branch_id OR _operation.operation_type <> 'close'
     OR _operation.request_payload <> _request OR _operation.actor_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Cash-session operation ID conflicts with a different request' USING ERRCODE='23505';
  END IF;
  IF _operation.session_id IS NOT NULL THEN RETURN _operation.session_id; END IF;

  _session := public.close_cash_session(_session_id,_counted_amount,_notes,_counted_card,_counted_transfer,_counted_qr);
  UPDATE public.cash_session_device_operations SET session_id=_session.id,completed_at=now()
   WHERE tenant_id=_tenant_id AND operation_id=_operation_id;
  RETURN _session.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.open_cash_session(uuid,uuid,numeric,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.close_cash_session(uuid,numeric,text,numeric,numeric,numeric) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.open_cash_session_v2_device(uuid,uuid,numeric,uuid,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.close_cash_session_v2_device(uuid,uuid,uuid,numeric,text,numeric,numeric,numeric,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.open_cash_session_v2_device(uuid,uuid,numeric,uuid,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_cash_session_v2_device(uuid,uuid,uuid,numeric,text,numeric,numeric,numeric,text,text,text) TO authenticated;

COMMIT;
