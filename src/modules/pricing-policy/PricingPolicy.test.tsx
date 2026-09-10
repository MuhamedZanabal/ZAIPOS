import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn(), setRule: vi.fn(), deactivate: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({supabase: {}}));
vi.mock('@/hooks/useTenantContext', () => ({ useTenantContext: () => ({ tenantId: 'tenant', branchId: 'branch',
  branches: [{id: 'branch', name: 'Manama'}], memberships: [{tenant_id: 'tenant', branch_id: null, role: 'manager'}] }) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: {products: [{id: 'product', name: 'Milk'}], categories: [], rules: []}, isLoading: false, error: null, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/lib/pricingPolicyCommands', async (original) => ({
  ...await original<object>(), previewPricing: api.preview, applyPricing: api.apply,
  setPricingRule: api.setRule, deactivatePricingRule: api.deactivate,
}));
import PricingPolicy from './PricingPolicy';
const preview = {product_id:'product', cost_fils:'1000', current_selling_price_fils:'1500', rounded_price_fils:'1325',
  raw_price_numerator:'13300000', rounding_adjustment_numerator:'-50000', markup_basis_points:3300,
  rule_scope:'system_default', cost_source:'product_base_cost', rounding_mode:'nearest_half_up'};
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); api.preview.mockResolvedValue([preview]); api.apply.mockResolvedValue([]); });

it('requires preview and explicit reason before committing', async () => {
  render(<PricingPolicy />);
  fireEvent.click(screen.getByLabelText('Select Milk'));
  fireEvent.click(screen.getByRole('button', {name:'Preview selected prices'}));
  await screen.findByText('BHD 1.325');
  expect(api.apply).not.toHaveBeenCalled();
  expect(screen.getByRole('button', {name:'Apply reviewed prices'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Repricing reason'), {target:{value:'Approved supermarket prices'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply reviewed prices'}));
  await screen.findByRole('status');
  expect(api.apply).toHaveBeenCalledTimes(1);
  expect(api.apply.mock.calls[0][3]).toEqual([preview]);
});

it('keeps the same operation identity when retrying an uncertain result', async () => {
  api.apply.mockRejectedValueOnce(new Error('Connection lost'));
  render(<PricingPolicy />);
  fireEvent.click(screen.getByLabelText('Select Milk'));
  fireEvent.click(screen.getByRole('button', {name:'Preview selected prices'}));
  await screen.findByText('BHD 1.325');
  fireEvent.change(screen.getByLabelText('Repricing reason'), {target:{value:'Approved prices'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply reviewed prices'}));
  await screen.findByText('Connection lost');
  fireEvent.click(screen.getByRole('button', {name:'Apply reviewed prices'}));
  await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(2));
  expect(api.apply.mock.calls[0]).toEqual(api.apply.mock.calls[1]);
});
