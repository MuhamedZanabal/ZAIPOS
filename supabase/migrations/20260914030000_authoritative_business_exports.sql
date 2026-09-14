BEGIN;
-- One scalar JSON snapshot avoids PostgREST's row cap and multi-request drift.
-- Explicit bounds fail with an error, never a successful truncated export.
CREATE FUNCTION public.export_business_data_v1(_tenant_id uuid,_branch_id uuid,_domain text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE _records jsonb; _count integer;
BEGIN
 IF auth.uid() IS NULL OR NOT public.has_branch_role(auth.uid(),_tenant_id,_branch_id,ARRAY['owner','admin','manager']::public.app_role[]) THEN RAISE EXCEPTION 'Forbidden'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.branches WHERE id=_branch_id AND tenant_id=_tenant_id AND status='active') THEN RAISE EXCEPTION 'Branch is not active'; END IF;
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=auth.uid() AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<=now())) THEN RAISE EXCEPTION 'User is not active'; END IF;
 IF EXISTS(SELECT 1 FROM public.employees WHERE user_id=auth.uid() AND tenant_id=_tenant_id AND (branch_id IS NULL OR branch_id=_branch_id) AND status='inactive') THEN RAISE EXCEPTION 'Employee is not active'; END IF;
 IF _domain='catalogue' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO _records FROM (
   SELECT p.id,p.name,p.sku,p.description,p.category_id,c.name AS category_name,
     p.price_fils::text,p.cost_fils::text,p.tax_rate::text,p.min_stock::text,p.status,p.unit_code,p.product_type,
     coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'barcode',b.barcode,'barcode_type',b.barcode_type,'is_primary',b.is_primary,'sort_order',b.sort_order) ORDER BY b.sort_order,b.id)
       FROM public.product_barcodes b WHERE b.tenant_id=_tenant_id AND b.product_id=p.id),'[]'::jsonb) AS product_barcodes
   FROM public.products p LEFT JOIN public.categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id
   WHERE p.tenant_id=_tenant_id ORDER BY p.id LIMIT 50001
  ) r;
 ELSIF _domain='inventory' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO _records FROM (
   SELECT s.id,s.product_id,p.name AS product,p.sku,s.inventory_center_id AS center_id,c.name AS center,s.quantity::text
   FROM public.inventory_stocks s JOIN public.products p ON p.id=s.product_id AND p.tenant_id=s.tenant_id
   JOIN public.inventory_centers c ON c.id=s.inventory_center_id AND c.tenant_id=s.tenant_id AND c.branch_id=s.branch_id
   WHERE s.tenant_id=_tenant_id AND s.branch_id=_branch_id ORDER BY s.id LIMIT 50001
  ) r;
 ELSE RAISE EXCEPTION 'Unsupported export domain'; END IF;
 _count:=jsonb_array_length(_records);
 IF _count>50000 OR octet_length(_records::text)>33554432 THEN RAISE EXCEPTION 'Export exceeds the 50,000-record or 32 MiB snapshot limit; use the controlled database export procedure'; END IF;
 RETURN jsonb_build_object('schema','zaipos.business-export.v1','domain',_domain,'tenant_id',_tenant_id,'branch_id',_branch_id,
  'exported_at',statement_timestamp(),'row_count',_count,'records',_records);
END; $$;
REVOKE ALL ON FUNCTION public.export_business_data_v1(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.export_business_data_v1(uuid,uuid,text) TO authenticated;
COMMIT;
