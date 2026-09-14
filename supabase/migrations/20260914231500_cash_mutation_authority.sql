BEGIN;
-- Table privileges vary between Supabase deployments. Neither grants nor old
-- permissive policies may create a competing authority for till totals.
REVOKE ALL ON public.cash_sessions,public.cash_movements FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.cash_sessions,public.cash_movements TO authenticated;
DROP POLICY IF EXISTS cash_sessions_branch_all ON public.cash_sessions;
DROP POLICY IF EXISTS cash_moves_branch_all ON public.cash_movements;

CREATE FUNCTION public.prevent_cash_movement_mutation_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Cash movement evidence is immutable'; END; $$;
REVOKE ALL ON FUNCTION public.prevent_cash_movement_mutation_v1() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER cash_movements_immutable BEFORE UPDATE OR DELETE ON public.cash_movements
FOR EACH ROW EXECUTE FUNCTION public.prevent_cash_movement_mutation_v1();

CREATE OR REPLACE FUNCTION public.add_cash_movement(_session_id uuid,_type text,_amount numeric,_reason text DEFAULT NULL)
RETURNS public.cash_movements LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE _s public.cash_sessions; _mv public.cash_movements; _fils bigint; _reason_value text:=btrim(coalesce(_reason,''));
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
 IF _type IS NULL OR _type NOT IN ('in','out') THEN RAISE EXCEPTION 'Invalid cash movement type'; END IF;
 IF _amount IS NULL OR _amount<=0 OR _amount<>round(_amount,3) OR _amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Cash amount must be positive exact fils'; END IF;
 IF length(_reason_value) NOT BETWEEN 2 AND 500 THEN RAISE EXCEPTION 'Cash movement reason must contain 2 to 500 characters'; END IF;
 _fils:=public.bhd_numeric_to_fils(_amount);
 SELECT * INTO _s FROM public.cash_sessions WHERE id=_session_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cash session not found'; END IF;
 IF NOT public.has_branch_role(auth.uid(),_s.tenant_id,_s.branch_id,ARRAY['owner','admin','manager','cashier']::public.app_role[]) THEN RAISE EXCEPTION 'Forbidden'; END IF;
 IF _s.status<>'open' THEN RAISE EXCEPTION 'Cash session is not open'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.branches WHERE id=_s.branch_id AND tenant_id=_s.tenant_id AND status='active') THEN RAISE EXCEPTION 'Branch is not active'; END IF;
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=auth.uid() AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<=now())) THEN RAISE EXCEPTION 'User is not active'; END IF;
 IF EXISTS(SELECT 1 FROM public.employees WHERE user_id=auth.uid() AND tenant_id=_s.tenant_id AND (branch_id IS NULL OR branch_id=_s.branch_id) AND status='inactive') THEN RAISE EXCEPTION 'Employee is not active'; END IF;
 INSERT INTO public.cash_movements(tenant_id,session_id,type,amount,reason,user_id)
 VALUES(_s.tenant_id,_s.id,_type,public.fils_to_bhd_numeric(_fils),_reason_value,auth.uid()) RETURNING * INTO _mv;
 UPDATE public.cash_sessions SET
  total_in=public.fils_to_bhd_numeric(total_in_fils+CASE WHEN _type='in' THEN _fils ELSE 0 END),
  total_out=public.fils_to_bhd_numeric(total_out_fils+CASE WHEN _type='out' THEN _fils ELSE 0 END)
 WHERE id=_s.id;
 INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
 VALUES(_s.tenant_id,auth.uid(),'cash.movement_recorded','cash_movements',_mv.id,
  jsonb_build_object('branch_id',_s.branch_id,'session_id',_s.id,'type',_type,'amount_fils',_fils));
 RETURN _mv;
END; $$;
REVOKE ALL ON FUNCTION public.add_cash_movement(uuid,text,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.add_cash_movement(uuid,text,numeric,text) TO authenticated;
COMMIT;
