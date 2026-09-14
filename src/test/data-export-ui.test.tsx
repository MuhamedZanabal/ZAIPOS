import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({csv:vi.fn(),error:vi.fn(),rpc:vi.fn(),from:vi.fn()}));
vi.mock('@/hooks/useTenantContext',()=>({useTenantContext:()=>({tenantId:'tenant',branchId:'branch'})}));
vi.mock('@/hooks/useInventoryCenters',()=>({useInventoryCenters:()=>({centers:[],defaultCenter:null})}));
vi.mock('@/lib/csv',async(importOriginal)=>({...await importOriginal<object>(),exportToCsv:mocks.csv}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc,from:mocks.from}}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:vi.fn()}}));
import { DataManagement } from '../modules/settings/DataManagement';
beforeEach(()=>{
 vi.clearAllMocks();
 const rows=Array.from({length:1501},(_,index)=>({id:String(index),name:'Product',sku:String(index),price_fils:'1251',cost_fils:'501',tax_rate:'10',product_barcodes:[]}));
 mocks.rpc.mockResolvedValue({data:{schema:'zaipos.business-export.v1',domain:'catalogue',tenant_id:'tenant',branch_id:'branch',exported_at:'2026-09-14T00:00:00Z',row_count:1501,records:rows},error:null});
 mocks.from.mockReturnValue({select:()=>({eq:async()=>({data:rows.slice(0,1000).map(row=>({...row,price:999,cost:888})),error:null})})});
});
it('exports beyond the REST row cap and derives decimal display from authoritative fils',async()=>{
 render(<DataManagement/>);fireEvent.click(screen.getByRole('button',{name:'Export Catalog (.csv)'}));
 await waitFor(()=>expect(mocks.csv).toHaveBeenCalled());
 const rows=mocks.csv.mock.calls[0][1];expect(rows).toHaveLength(1501);
 expect(rows[0].price_fils).toBe('1251');expect(rows[0].price).toBe('1.251');expect(rows[0].cost).toBe('0.501');
 expect(rows[0].export_timestamp_utc).toBe('2026-09-14T00:00:00Z');
});
it('does not download data if the server denies export authorization',async()=>{
 mocks.rpc.mockResolvedValue({data:null,error:{message:'Forbidden'}});
 render(<DataManagement/>);fireEvent.click(screen.getByRole('button',{name:'Export Catalog (.csv)'}));
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());expect(mocks.csv).not.toHaveBeenCalled();
});
