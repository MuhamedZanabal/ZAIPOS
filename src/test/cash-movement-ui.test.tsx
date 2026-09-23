import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({cashMovement:vi.fn(),getSession:vi.fn(),error:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:mocks.getSession}}}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:vi.fn()}}));
import {CashMovementDialog} from '../modules/cash/Cash';
const tenantId='a7000000-0000-4000-8000-000000000001';const branchId='b7000000-0000-4000-8000-000000000001';
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async (_key: string, callback: ()=>unknown)=>callback()}});mocks.getSession.mockResolvedValue({data:{session:{access_token:'operator-token'}},error:null});mocks.cashMovement.mockResolvedValue('f7000000-0000-0000-0000-000000000001');window.electron={cashMovement:mocks.cashMovement} as any;});
it('does not round a fractional-fil cash entry into a different amount',async()=>{
 render(<CashMovementDialog open type="in" sessionId="e7000000-0000-0000-0000-000000000001" actorId="cashier" tenantId={tenantId} branchId={branchId} onClose={()=>undefined}/>);
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.0001'}});
 fireEvent.change(screen.getByPlaceholderText('e.g. Extra float'),{target:{value:'Verified float'}});
 fireEvent.change(screen.getByLabelText('Movement reference'),{target:{value:'FLOAT-PRECISION-001'}});
 fireEvent.click(screen.getByRole('button',{name:'Record'}));
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());expect(mocks.cashMovement).not.toHaveBeenCalled();
});
it('sends exact canonical decimal text to PostgreSQL',async()=>{
 render(<CashMovementDialog open type="in" sessionId="e7000000-0000-0000-0000-000000000001" actorId="cashier" tenantId={tenantId} branchId={branchId} onClose={()=>undefined}/>);
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.001'}});
 fireEvent.change(screen.getByPlaceholderText('e.g. Extra float'),{target:{value:'Verified float'}});
 fireEvent.change(screen.getByLabelText('Movement reference'),{target:{value:'FLOAT-PRECISION-001'}});
 fireEvent.click(screen.getByRole('button',{name:'Record'}));
 await waitFor(()=>expect(mocks.cashMovement).toHaveBeenCalled());expect(mocks.cashMovement.mock.calls[0][0]._amount).toBe('1.001');
});
