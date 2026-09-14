import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc}}));
import { downloadBusinessJson, exportBusinessData, exportCsvRows, type BusinessExport } from './businessExports';
const snapshot=():BusinessExport=>({schema:'zaipos.business-export.v1',domain:'catalogue',tenant_id:'tenant',branch_id:'branch',exported_at:'2026-09-14T00:00:00Z',row_count:1,records:[{id:'product',name:'=SUM(1,2)\nحليب',price_fils:'9007199254740993',cost_fils:'1',product_barcodes:[{barcode:'ABC|DEF',is_primary:true}]}]});
beforeEach(()=>vi.clearAllMocks());
it('formats fils without a floating-point conversion',()=>{
 const rows=exportCsvRows(snapshot());expect(rows[0].price).toBe('9007199254740.993');expect(rows[0].cost).toBe('0.001');
});
it('fails closed on wrong scope, missing rows and numeric rather than textual money',async()=>{
 for(const data of [{...snapshot(),tenant_id:'other'},{...snapshot(),row_count:2},{...snapshot(),records:[{...snapshot().records[0],price_fils:1251}]}]){
  mocks.rpc.mockResolvedValue({data,error:null});await expect(exportBusinessData('tenant','branch','catalogue')).rejects.toThrow();
 }
});
it('downloads JSON without spreadsheet transformations and revokes the URL',async()=>{
 const create=vi.fn(()=> 'blob:snapshot'),revoke=vi.fn();vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:create,revokeObjectURL:revoke}));
 const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>undefined);
 const data=snapshot();downloadBusinessJson('snapshot.json',data);
 const reader=new FileReader();const text=await new Promise<string>((resolve)=>{reader.onload=()=>resolve(String(reader.result));reader.readAsText(create.mock.calls[0][0]);});
 expect(JSON.parse(text)).toEqual(data);expect(revoke).toHaveBeenCalledWith('blob:snapshot');click.mockRestore();
});
