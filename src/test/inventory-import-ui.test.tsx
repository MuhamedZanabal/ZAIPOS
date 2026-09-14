import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ reconcile:vi.fn(), error:vi.fn(), lookup:vi.fn() }));
vi.mock('@/hooks/useTenantContext',()=>({useTenantContext:()=>({tenantId:'tenant',branchId:'branch'})}));
vi.mock('@/hooks/useInventoryCenters',()=>({useInventoryCenters:()=>({centers:[{id:'center',name:'Main'}],defaultCenter:{id:'center',name:'Main'}})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:mocks.lookup};return q;}}}));
vi.mock('@/lib/inventory',()=>({createInventoryMutationId:()=> 'operation',reconcileInventoryLevelsV2:mocks.reconcile}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:vi.fn()}}));
import { DataManagement } from '../modules/settings/DataManagement';
beforeEach(()=>{vi.clearAllMocks();mocks.lookup.mockResolvedValue({data:{id:'product'},error:null});mocks.reconcile.mockResolvedValue('operation');});
it('never converts a blank physical count into zero stock',async()=>{
 render(<DataManagement />);
 fireEvent.change(screen.getByLabelText('Import Stock (Physical Adjustment)'),{target:{files:[{text:async()=> 'sku,quantity,count_reference\nSKU-1,,61000000-0000-0000-0000-000000000001'}]}});
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());
 expect(mocks.reconcile).not.toHaveBeenCalled();
});
it('rejects the whole import when any SKU is unresolved',async()=>{
 mocks.lookup.mockResolvedValueOnce({data:{id:'product'},error:null}).mockResolvedValueOnce({data:null,error:null});
 render(<DataManagement />);
 fireEvent.change(screen.getByLabelText('Import Stock (Physical Adjustment)'),{target:{files:[{text:async()=> 'sku,quantity,count_reference\nSKU-1,2,61000000-0000-0000-0000-000000000001\nUNKNOWN,3,61000000-0000-0000-0000-000000000001'}]}});
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());
 expect(mocks.reconcile).not.toHaveBeenCalled();
});
it('accepts explicit zero without rounding a one-thousandth count',async()=>{
 mocks.lookup.mockResolvedValueOnce({data:{id:'zero-product'},error:null}).mockResolvedValueOnce({data:{id:'fraction-product'},error:null});
 render(<DataManagement />);
 fireEvent.change(screen.getByLabelText('Import Stock (Physical Adjustment)'),{target:{files:[{text:async()=> 'sku,quantity,count_reference\nZERO,0,61000000-0000-0000-0000-000000000001\nFRACTION,1.001,61000000-0000-0000-0000-000000000001'}]}});
 await waitFor(()=>expect(mocks.reconcile).toHaveBeenCalledTimes(1));
 expect(mocks.reconcile.mock.calls[0][0].targets).toEqual([{productId:'fraction-product',targetQuantity:1.001,effectKey:'sku:FRACTION'},{productId:'zero-product',targetQuantity:0,effectKey:'sku:ZERO'}]);
});
it('rejects a physical count exported from another destination center',async()=>{
 render(<DataManagement />);
 fireEvent.change(screen.getByLabelText('Import Stock (Physical Adjustment)'),{target:{files:[{text:async()=> 'sku,quantity,center,count_reference\nSKU-1,2,Other,61000000-0000-0000-0000-000000000001'}]}});
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());
 expect(mocks.reconcile).not.toHaveBeenCalled();
});
