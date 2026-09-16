import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),error:vi.fn(),session:null as any}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc}}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:vi.fn()}}));
vi.mock('@/hooks/useTenantContext',()=>({useTenantContext:()=>({tenantId:'tenant',branchId:'branch',hasRole:()=>true})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({user:{id:'actor'}})}));
vi.mock('@/hooks/useOpenSession',()=>({useOpenSession:()=>({data:mocks.session})}));
vi.mock('@tanstack/react-query',()=>({useQuery:()=>({data:[]}),useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/modules/cash/PendingTableOrders',()=>({PendingTableOrders:()=>null}));
import Cash from '@/modules/cash/Cash';
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();mocks.session=null;mocks.rpc.mockResolvedValue({data:{id:'session'},error:null});});
it('rejects fractional-fils opening instead of rounding the typed float',async()=>{
 render(<Cash/>);fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.0001'}});
 fireEvent.click(screen.getByRole('button',{name:/Open register now/}));
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());expect(mocks.rpc).not.toHaveBeenCalled();
});
it('sends exact opening decimal text',async()=>{
 render(<Cash/>);fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.001'}});
 fireEvent.click(screen.getByRole('button',{name:/Open register now/}));
 await waitFor(()=>expect(mocks.rpc).toHaveBeenCalled());expect(mocks.rpc.mock.calls[0][1]._opening_amount).toBe('1.001');
});
it('requires all blind close counts explicitly, including zero buckets',async()=>{
 mocks.session={id:'session',opening_amount:1,total_cash:0,total_card:0,total_transfer:0,total_qr:0,total_in:0,total_out:0};
 render(<Cash/>);fireEvent.click(screen.getByRole('button',{name:/Close register/}));
 fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Close register'}));
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());expect(mocks.rpc).not.toHaveBeenCalled();
});
