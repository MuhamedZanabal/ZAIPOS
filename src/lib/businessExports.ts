import { supabase } from '@/integrations/supabase/client';

export type ExportDomain='catalogue'|'inventory';
export interface BusinessExport {
 schema:'zaipos.business-export.v1';domain:ExportDomain;tenant_id:string;branch_id:string;exported_at:string;
 row_count:number;records:Record<string,unknown>[];
}
export async function exportBusinessData(tenantId:string|null,branchId:string|null,domain:ExportDomain):Promise<BusinessExport> {
 if(!tenantId||!branchId)throw new Error('Select a business and branch before exporting');
 const {data,error}=await supabase.rpc('export_business_data_v1' as never,{_tenant_id:tenantId,_branch_id:branchId,_domain:domain} as never);
 if(error)throw error;
 const result=data as unknown as BusinessExport;
 if(!result||result.schema!=='zaipos.business-export.v1'||result.domain!==domain||result.tenant_id!==tenantId||result.branch_id!==branchId||
   !Number.isFinite(Date.parse(result.exported_at))||!Array.isArray(result.records)||result.row_count!==result.records.length||result.row_count>50000)throw new Error('Invalid or incomplete export snapshot');
 for(const row of result.records){
  if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string')throw new Error('Invalid export record');
  if(domain==='catalogue'&&(!exactFils(row.price_fils)||!exactFils(row.cost_fils)||!Array.isArray(row.product_barcodes)))throw new Error('Export contains invalid monetary evidence');
  if(domain==='inventory'&&(typeof row.quantity!=='string'||!/^-?\d+(?:\.\d{1,3})?$/.test(row.quantity)))throw new Error('Export contains invalid quantity evidence');
 }
 return result;
}
function exactFils(value:unknown):value is string{return typeof value==='string'&&/^\d+$/.test(value);}
function decimalFils(value:unknown):string {
 if(!exactFils(value))throw new Error('Invalid integer fils');
 const fils=BigInt(value);return `${fils/1000n}.${(fils%1000n).toString().padStart(3,'0')}`;
}
export function exportCsvRows(snapshot:BusinessExport):Record<string,unknown>[] {
 const countReference=snapshot.domain==='inventory'?crypto.randomUUID():null;
 return snapshot.records.map(row=>{
  const scope={tenant_id:snapshot.tenant_id,branch_id:snapshot.branch_id,export_timestamp_utc:snapshot.exported_at};
  if(snapshot.domain==='inventory')return {...row,...scope,count_reference:countReference};
  const {product_barcodes,...values}=row;
  const barcodes=product_barcodes as {barcode:string;is_primary:boolean}[];
  return {...values,...scope,price:decimalFils(row.price_fils),cost:decimalFils(row.cost_fils),barcode:barcodes.find(b=>b.is_primary)?.barcode??'',barcodes:barcodes.map(b=>b.barcode).join('|')};
 });
}
export function downloadBusinessJson(filename:string,snapshot:BusinessExport):void {
 const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)+'\n'],{type:'application/json;charset=utf-8'}));
 const link=document.createElement('a');
 try{link.href=url;link.download=filename;document.body.appendChild(link);link.click();}
 finally{link.remove();URL.revokeObjectURL(url);}
}
