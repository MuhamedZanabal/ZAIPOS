import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), collect: vi.fn(), invalidate: vi.fn(), error: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  rpc: mocks.rpc,
  auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'operator-token' } }, error: null })) },
} }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: {id:'cashier'} }) }));
vi.mock('@/hooks/useTenantContext', () => ({ useTenantContext: () => ({ tenantId:'tenant', branchId:'branch', branches:[{id:'branch',name:'Branch'}], roles:['cashier'] }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useQuery: () => ({ data: {orders:[{id:'order-1',status:'on_way',customer_name:'Contract Customer',address:'Bahrain',created_at:'2026-09-13T10:00:00Z',collection_total_fils:'1251'}],sessions:[{id:'session-1',register_name:'Till One',opened_at:'2026-09-13T09:00:00Z'}],limit:100},isLoading:false,error:null }),
}));
vi.mock('sonner', () => ({toast:{success:vi.fn(),error:mocks.error}}));
import CourierDashboard from '../modules/courier/CourierDashboard';
describe('courier atomic collection workflow', () => {
  beforeEach(() => { vi.clearAllMocks(); window.electron = { collectDeliveryPayment: mocks.collect } as any; });
  it('selects an explicit register and sends one operation without client money or separate completion', async () => {
    mocks.collect.mockResolvedValue('collection-1');
    render(<CourierDashboard />);
    fireEvent.click(screen.getByRole('button',{name:'Collect and deliver'}));
    expect(screen.getByRole('button',{name:'Confirm delivery'})).toBeDisabled();
    expect(screen.getAllByText('BHD 1.251').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Receiving register'),{target:{value:'session-1'}});
    fireEvent.click(screen.getByRole('button',{name:'Confirm delivery'}));
    await waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(1));
    expect(mocks.collect).toHaveBeenCalledWith({
      _tenant_id:'tenant',_branch_id:'branch',_order_id:'order-1',_method:'cash',_session_id:'session-1',_client_mutation_id:'delivery-collect:order-1',_reference:null,
    }, {accessToken:'operator-token',tenantId:'tenant',branchId:'branch'});
    expect(mocks.rpc).not.toHaveBeenCalledWith('collect_delivery_payment_v2',expect.anything());
  });
  it('keeps a rejected collection visible for retry and never completes status separately', async () => {
    mocks.collect.mockRejectedValue(new Error('Receiving register is closed'));
    render(<CourierDashboard />);
    fireEvent.click(screen.getByRole('button',{name:'Collect and deliver'}));
    fireEvent.change(screen.getByLabelText('Receiving register'),{target:{value:'session-1'}});
    fireEvent.click(screen.getByRole('button',{name:'Confirm delivery'}));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Receiving register is closed'));
    expect(screen.getByRole('button',{name:'Confirm delivery'})).toBeInTheDocument();
    expect(mocks.collect).toHaveBeenCalledTimes(1);
  });
  it('fails closed outside the provisioned desktop bridge', async () => {
    window.electron = undefined;
    render(<CourierDashboard />);
    fireEvent.click(screen.getByRole('button',{name:'Collect and deliver'}));
    fireEvent.change(screen.getByLabelText('Receiving register'),{target:{value:'session-1'}});
    fireEvent.click(screen.getByRole('button',{name:'Confirm delivery'}));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringMatching(/provisioned desktop/i)));
    expect(mocks.rpc).not.toHaveBeenCalledWith('collect_delivery_payment_v2',expect.anything());
  });
});
