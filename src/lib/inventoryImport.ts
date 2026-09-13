import { parseCsv } from './csv';

export function parseInventoryCounts(content: string): {sku:string;quantity:number;center?:string}[] {
  const rows=parseCsv(content);
  if (!rows.length) throw new Error('Inventory import must contain physical counts');
  const seen=new Set<string>();
  return rows.map((row,index)=>{
    const sku=String(row.sku ?? '').trim();
    if (!sku) throw new Error(`Missing SKU on inventory row ${index+2}`);
    if (seen.has(sku)) throw new Error(`Duplicate SKU in inventory import: ${sku}`);
    seen.add(sku);
    const value=String(row.quantity ?? '').trim();
    if (!/^\d+(?:\.\d{1,3})?$/.test(value)) throw new Error(`Invalid physical quantity for SKU ${sku}: enter an explicit non-negative count with at most three decimals`);
    const [whole,fraction='']=value.split('.');
    const milliunits=BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));
    if (milliunits>999999999999n) throw new Error(`Physical quantity exceeds the database limit for SKU ${sku}`);
    return {sku,quantity:Number(milliunits)/1000,center:row.center?.trim() || undefined};
  });
}
