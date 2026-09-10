import { describe, expect, it, vi, beforeEach } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
import { formatPricingFils, formatRawPrice, markupBasisPoints, previewPricing, applyPricing } from './pricingPolicyCommands';

describe('pricing approval client', () => {
  beforeEach(() => rpc.mockReset());
  it('formats exact BHD including values above the Number safe range', () => {
    expect(formatPricingFils('25')).toBe('BHD 0.025');
    expect(formatPricingFils('9007199254740993')).toBe('BHD 9007199254740.993');
    expect(formatRawPrice('16625000')).toBe('BHD 1.6625000');
  });
  it('parses markup without floating point', () => {
    expect(markupBasisPoints('33')).toBe(3300);
    expect(markupBasisPoints('33.25')).toBe(3325);
    for (const invalid of ['-1', 'NaN', '33.255', '10000.01', '1e2']) {
      expect(() => markupBasisPoints(invalid)).toThrow();
    }
  });
  it('preview only calls the read command', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await previewPricing('tenant', null, null, ['product']);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('preview_pricing_batch_v1', {
      _tenant_id: 'tenant', _branch_id: null, _channel: null, _product_ids: ['product'],
    });
  });
  it('retries use the supplied operation identity and reviewed payload', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await applyPricing('tenant', null, null, [], 'Reviewed prices', 'fixed-operation');
    await applyPricing('tenant', null, null, [], 'Reviewed prices', 'fixed-operation');
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc.mock.calls[0][0]).toBe('apply_pricing_batch_v1');
  });
  it('surfaces stale approval failure without retrying a write', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Stale pricing preview' } });
    await expect(applyPricing('tenant', null, null, [], 'Reviewed prices', 'fixed-operation')).rejects.toThrow('Stale pricing preview');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
