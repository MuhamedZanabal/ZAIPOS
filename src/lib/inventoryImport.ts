import { parseCsv } from './csv';

export function parseInventoryCounts(content: string, scope?: {tenantId:string;branchId:string;centerId:string}): {sku:string;quantity:number;center?:string;countReference:string}[] {
  const rows=parseCsv(content);
  if (!rows.length) throw new Error('Inventory import must contain physical counts');
  const seen=new Set<string>();
  let countReference: string | undefined;
  return rows.map((row,index)=>{
    if(scope)for(const [field,expected] of [['tenant_id',scope.tenantId],['branch_id',scope.branchId],['center_id',scope.centerId]]) {
      if(row[field]?.trim() && row[field].trim()!==expected)throw new Error(`Inventory count ${field} does not match the selected destination`);
    }
    const reference=String(row.count_reference ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reference)) throw new Error('Every inventory row requires a UUID count_reference. Export a new count file to start a new physical count; retain its reference for retries.');
    if (countReference && reference !== countReference) throw new Error('All rows must belong to the same count_reference');
    countReference=reference;
    const sku=String(row.sku ?? '').trim();
    if (!sku) throw new Error(`Missing SKU on inventory row ${index+2}`);
    if (seen.has(sku)) throw new Error(`Duplicate SKU in inventory import: ${sku}`);
    seen.add(sku);
    const value=String(row.quantity ?? '').trim();
    if (!/^\d+(?:\.\d{1,3})?$/.test(value)) throw new Error(`Invalid physical quantity for SKU ${sku}: enter an explicit non-negative count with at most three decimals`);
    const [whole,fraction='']=value.split('.');
    const milliunits=BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));
    if (milliunits>999999999999n) throw new Error(`Physical quantity exceeds the database limit for SKU ${sku}`);
    return {sku,quantity:Number(milliunits)/1000,center:row.center?.trim() || undefined,countReference:reference};
  });
}

/** Identity names the count, not its contents: altered payloads must reach the
 * server with the same ID and be rejected by its immutable payload binding. */
export async function inventoryCountOperationId(tenantId:string,branchId:string,centerId:string,countReference:string): Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([tenantId,branchId,centerId,countReference])));
  return `inventory-count-${Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')}`;
}
