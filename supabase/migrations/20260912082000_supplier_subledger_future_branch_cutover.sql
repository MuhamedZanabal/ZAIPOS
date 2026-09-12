-- Ensure branches created after supplier-subledger rollout receive a cutover row.

BEGIN;

CREATE OR REPLACE FUNCTION public.initialize_supplier_subledger_cutover_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.supplier_subledger_cutovers(tenant_id,branch_id,activated_at)
  VALUES(NEW.tenant_id,NEW.id,now())
  ON CONFLICT (tenant_id,branch_id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.initialize_supplier_subledger_cutover_v1()
FROM PUBLIC, anon, authenticated;

CREATE TRIGGER branches_supplier_subledger_cutover
AFTER INSERT ON public.branches
FOR EACH ROW EXECUTE FUNCTION public.initialize_supplier_subledger_cutover_v1();

COMMIT;
