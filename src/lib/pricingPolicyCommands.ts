import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { Database, Json } from '@/integrations/supabase/types';

export type PricingChannel = Database['public']['Enums']['sales_channel'] | null;
const exact = z.string().regex(/^\d+$/);
const previewSchema = z.object({
  tenant_id: z.string(), product_id: z.string(), branch_id: z.string().nullable(),
  channel: z.string().nullable(), category_id: z.string().nullable(),
  cost_fils: exact, current_selling_price_fils: exact, rounded_price_fils: exact,
  raw_price_numerator: exact, raw_price_denominator: z.literal('10000'),
  rounding_adjustment_numerator: z.string().regex(/^-?\d+$/),
  markup_basis_points: z.number().int().min(0).max(1000000),
  rounding_increment_fils: z.literal(25), rounding_mode: z.enum(['nearest_half_up', 'ceil']),
  rule_id: z.string().nullable(), rule_scope: z.string(), cost_source: z.string(),
  cost_event_id: z.string().nullable(), selling_price_event_id: z.string().nullable(),
  previewed_by: z.string(), generated_at: z.string(),
});
export type PricingPreview = z.infer<typeof previewSchema>;

function decimal(value: string, places: number) {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const digits = absolute.toString().padStart(places + 1, '0');
  return `${amount < 0n ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
export const formatPricingFils = (fils: string) => `BHD ${decimal(fils, 3)}`;
export const pricingDifference = (current: string, proposed: string) =>
  (BigInt(proposed) - BigInt(current)).toString();
// cost_fils * basis-points factor / 10000 / 1000 = BHD with 7 places.
export const formatRawPrice = (numerator: string) => `BHD ${decimal(numerator, 7)}`;
export const formatMarkup = (basisPoints: number) => `${decimal(String(basisPoints), 2)}%`;
export function markupBasisPoints(input: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(input)) throw new Error('Enter a nonnegative markup with up to two decimal places.');
  const [whole, fraction = ''] = input.split('.');
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (value > 1000000n) throw new Error('Markup must not exceed 10000%.');
  return Number(value); // bounded exact integer, never money
}

export async function previewPricing(tenant: string, branch: string | null, channel: PricingChannel, products: string[]) {
  const { data, error } = await supabase.rpc('preview_pricing_batch_v1', {
    _tenant_id: tenant, _branch_id: branch, _channel: channel, _product_ids: products,
  });
  if (error) throw new Error(error.message);
  return z.array(previewSchema).parse(data);
}

export async function applyPricing(tenant: string, branch: string | null, channel: PricingChannel,
  previews: PricingPreview[], reason: string, operationId: string) {
  const { data, error } = await supabase.rpc('apply_pricing_batch_v1', {
    _tenant_id: tenant, _branch_id: branch, _channel: channel,
    _previews: previews as Json, _reason: reason, _operation_id: operationId,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function setPricingRule(tenant: string, branch: string | null, category: string | null,
  product: string | null, markup: string, mode: 'nearest_half_up' | 'ceil', reason: string, operationId: string) {
  const { data, error } = await supabase.rpc('set_pricing_policy_rule_v1', {
    _tenant_id: tenant, _branch_id: branch, _category_id: category, _product_id: product,
    _markup_basis_points: markupBasisPoints(markup), _rounding_increment_fils: 25,
    _rounding_mode: mode, _reason: reason, _operation_id: operationId,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function deactivatePricingRule(tenant: string, rule: string, reason: string, operationId: string) {
  const { error } = await supabase.rpc('deactivate_pricing_policy_rule_v1', {
    _tenant_id: tenant, _rule_id: rule, _reason: reason, _operation_id: operationId,
  });
  if (error) throw new Error(error.message);
}
