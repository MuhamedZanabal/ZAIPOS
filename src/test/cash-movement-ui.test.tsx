import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),error:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc}}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:vi.fn()}}));
import {CashMovementDialog} from '../modules/cash/Cash';
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async (_key: string, callback: ()=>unknown)=>callback()}});mocks.rpc.mockResolvedValue({data:'f7000000-0000-0000-0000-000000000001',error:null});});
it('does not round a fractional-fil cash entry into a different amount',async()=>{
 render(<CashMovementDialog open type="in" sessionId="e7000000-0000-0000-0000-000000000001" actorId="cashier" onClose={()=>undefined}/>);
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.0001'}});
 fireEvent.change(screen.getByPlaceholderText('e.g. Extra float'),{target:{value:'Verified float'}});
 fireEvent.change(screen.getByLabelText('Movement reference'),{target:{value:'FLOAT-PRECISION-001'}});
 fireEvent.click(screen.getByRole('button',{name:'Record'}));
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());expect(mocks.rpc).not.toHaveBeenCalled();
});
it('sends exact canonical decimal text to PostgreSQL',async()=>{
 render(<CashMovementDialog open type="in" sessionId="e7000000-0000-0000-0000-000000000001" actorId="cashier" onClose={()=>undefined}/>);
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.001'}});
 fireEvent.change(screen.getByPlaceholderText('e.g. Extra float'),{target:{value:'Verified float'}});
 fireEvent.change(screen.getByLabelText('Movement reference'),{target:{value:'FLOAT-PRECISION-001'}});
 fireEvent.click(screen.getByRole('button',{name:'Record'}));
 await waitFor(()=>expect(mocks.rpc).toHaveBeenCalled());expect(mocks.rpc.mock.calls[0][1]._amount).toBe('1.001');
});
