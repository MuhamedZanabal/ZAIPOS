import { expect, it } from 'vitest';
import { inventoryCountOperationId, parseInventoryCounts } from './inventoryImport';
const reference='61000000-0000-0000-0000-000000000001';
it('isolates count identity by tenant, branch, center and reference',async()=>{
 const base=['tenant','branch','center',reference] as const;
 const original=await inventoryCountOperationId(...base);
 expect(await inventoryCountOperationId(...base)).toBe(original);
 for(let index=0;index<4;index++) {
  const changed=[...base];changed[index]+='-different';
  expect(await inventoryCountOperationId(changed[0],changed[1],changed[2],changed[3])).not.toBe(original);
 }
});
it('rejects files combining separate counts',()=>{
 expect(()=>parseInventoryCounts(`sku,quantity,count_reference\nA,1,${reference}\nB,2,61000000-0000-0000-0000-000000000002`)).toThrow(/same count_reference/);
});
it('normalizes reference casing without changing exact thousandths',()=>{
 const lower='abcdef00-0000-0000-0000-000000000001';
 const result=parseInventoryCounts(`sku,quantity,count_reference\nA,0.001,${lower.toUpperCase()}`);
 expect(result[0].countReference).toBe(lower);expect(result[0].quantity).toBe(0.001);
});
it('rejects exported destination identity mismatches even when center names match',()=>{
 for(const field of ['tenant_id','branch_id','center_id'])expect(()=>parseInventoryCounts(`sku,quantity,count_reference,${field}\nA,1,${reference},wrong`,{tenantId:'tenant',branchId:'branch',centerId:'center'})).toThrow(/selected destination/);
});
