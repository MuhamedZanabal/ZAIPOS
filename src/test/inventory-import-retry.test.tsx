import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({reconcile:vi.fn(),error:vi.fn(),success:vi.fn()}));
vi.mock('@/hooks/useTenantContext',()=>({useTenantContext:()=>({tenantId:'tenant',branchId:'branch'})}));
vi.mock('@/hooks/useInventoryCenters',()=>({useInventoryCenters:()=>({centers:[{id:'center',name:'Main'}],defaultCenter:{id:'center',name:'Main'}})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{id:'product'},error:null})};return q;}}}));
vi.mock('@/lib/inventory',()=>({createInventoryMutationId:()=>crypto.randomUUID(),reconcileInventoryLevelsV2:mocks.reconcile}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:mocks.success}}));
import { DataManagement } from '../modules/settings/DataManagement';
const reference='61000000-0000-0000-0000-000000000001';
const file=(ref=reference,quantity=10)=>({text:async()=>`sku,quantity,count_reference\nSKU-1,${quantity},${ref}`});
const upload=(value=file())=>fireEvent.change(screen.getByLabelText('Import Stock (Physical Adjustment)'),{target:{files:[value]}});
beforeEach(()=>{vi.clearAllMocks();mocks.reconcile.mockResolvedValue('operation');});
it('reuses count identity after commit, lost response, intervening sale and screen restart',async()=>{
 let stock=5;const committed=new Set<string>();
 mocks.reconcile.mockImplementation(async(args)=>{
  if(committed.has(args.clientMutationId))return 'original-operation';
  stock=args.targets[0].targetQuantity;committed.add(args.clientMutationId);
  if(committed.size===1)throw new Error('Response lost after commit');
  return 'second-operation';
 });
 render(<DataManagement/>);upload();await waitFor(()=>expect(mocks.error).toHaveBeenCalled());
 expect(stock).toBe(10);stock-=1;
 cleanup();render(<DataManagement/>);upload();await waitFor(()=>expect(mocks.success).toHaveBeenCalled());
 expect(stock).toBe(9);expect(committed.size).toBe(1);
 expect(mocks.reconcile.mock.calls[1][0]).toEqual(mocks.reconcile.mock.calls[0][0]);
});
it('requires a count reference before sending an import',async()=>{
 render(<DataManagement/>);upload({text:async()=> 'sku,quantity\nSKU-1,10'});
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());expect(mocks.reconcile).not.toHaveBeenCalled();
});
it('keeps an altered payload on the same operation so the server can reject substitution',async()=>{
 render(<DataManagement/>);upload();await waitFor(()=>expect(mocks.success).toHaveBeenCalledTimes(1));
 upload(file(reference,11));await waitFor(()=>expect(mocks.success).toHaveBeenCalledTimes(2));
 expect(mocks.reconcile.mock.calls[1][0].clientMutationId).toBe(mocks.reconcile.mock.calls[0][0].clientMutationId);
 expect(mocks.reconcile.mock.calls[1][0].targets).not.toEqual(mocks.reconcile.mock.calls[0][0].targets);
});
