import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTenantContext } from '@/hooks/useTenantContext';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { applyPricing, deactivatePricingRule, formatMarkup, formatPricingFils, formatRawPrice,
  previewPricing, setPricingRule, type PricingChannel, type PricingPreview } from '@/lib/pricingPolicyCommands';

const managerRoles = ['owner', 'admin', 'manager'];
const inputClass = 'rounded-md border bg-background px-3 py-2 w-full';

export default function PricingPolicy() {
  const context = useTenantContext();
  if (!context.tenantId) return <p>Select a business to manage pricing.</p>;
  return <PricingWorkspace key={`${context.tenantId}:${context.branchId}`} context={context} tenant={context.tenantId} />;
}

function PricingWorkspace({ context, tenant }: { context: ReturnType<typeof useTenantContext>; tenant: string }) {
  const queryClient = useQueryClient();
  const memberships = context.memberships.filter(m => m.tenant_id === tenant && managerRoles.includes(m.role));
  const global = memberships.some(m => m.branch_id === null);
  const branches = context.branches.filter(b => global || memberships.some(m => m.branch_id === b.id));
  const [branch, setBranch] = useState(global ? '' : branches[0]?.id ?? '');
  const [channel, setChannel] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [previews, setPreviews] = useState<PricingPreview[]>([]);
  const [previewedAt, setPreviewedAt] = useState('');
  const [reason, setReason] = useState('');
  const [ruleReason, setRuleReason] = useState('');
  const [target, setTarget] = useState('scope');
  const [targetId, setTargetId] = useState('');
  const [markup, setMarkup] = useState('33');
  const [mode, setMode] = useState<'nearest_half_up' | 'ceil'>('nearest_half_up');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const running = useRef(false);
  const operations = useRef(new Map<string, string>());
  const allowed = global || memberships.some(m => m.branch_id === branch);
  const catalogue = useQuery({
    queryKey: ['pricing-catalogue', tenant, search], enabled: memberships.length > 0,
    queryFn: async () => {
      const [products, categories, rules] = await Promise.all([
        supabase.from('products').select('id,name').eq('tenant_id', tenant).eq('status', 'active')
          .ilike('name', `%${search}%`).order('name').limit(100),
        supabase.from('categories').select('id,name').eq('tenant_id', tenant).eq('status', 'active').order('name').limit(1000),
        supabase.from('pricing_policy_rules').select('*').eq('tenant_id', tenant).is('effective_to', null).order('created_at', {ascending:false}).limit(1000),
      ]);
      for (const result of [products, categories, rules]) if (result.error) throw new Error(result.error.message);
      return {products: products.data ?? [], categories: categories.data ?? [], rules: rules.data ?? []};
    },
  });
  const refresh = async () => {
    await Promise.allSettled(['pricing-catalogue', 'products', 'branch-products', 'channel-prices'].map(queryKey =>
      queryClient.invalidateQueries({queryKey:[queryKey]})));
  };
  async function run(key: string, action: (operation: string) => Promise<unknown>, message = '') {
    if (running.current || !allowed) return;
    running.current = true; setBusy(true); setError(''); setSuccess('');
    const id = operations.current.get(key) ?? crypto.randomUUID();
    operations.current.set(key, id);
    try {
      await action(id);
      operations.current.delete(key);
      setSuccess(message);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Pricing request failed. Retry with the same reviewed selection.'); }
    finally { running.current = false; setBusy(false); }
  }
  function clearPreview() { setPreviews([]); setSuccess(''); setError(''); }
  const scope = [tenant, branch || null, channel || null] as const;
  const products = catalogue.data?.products ?? [];
  const rules = (catalogue.data?.rules ?? []).filter(r => r.branch_id === null || r.branch_id === branch);

  if (!memberships.length) return <p role="alert">A manager role is required to manage pricing policies.</p>;
  return <main className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
    <div><h1 className="text-2xl font-semibold">Pricing policies</h1>
      <p className="text-muted-foreground">Recommend prices from cost, review the calculation, then apply approved changes.</p>
      <p className="text-sm">Default: cost + 33%, rounded to the nearest 25 fils; halfway rounds upward. Receiving stock does not change selling prices.</p></div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {success && <p role="status">{success}</p>}
    {catalogue.error && <div role="alert">{catalogue.error.message} <Button onClick={() => catalogue.refetch()}>Retry catalogue</Button></div>}
    {catalogue.isLoading && <p>Loading products and policies…</p>}
    <fieldset disabled={busy} className="grid md:grid-cols-2 gap-4">
      <label>Price scope<select aria-label="Price scope" className={inputClass} value={branch} onChange={e => {setBranch(e.target.value); clearPreview();}}>
        {global && <option value="">Tenant base prices</option>}
        {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select></label>
      <label>Sales channel<select aria-label="Sales channel" className={inputClass} value={channel} onChange={e => {setChannel(e.target.value); clearPreview();}}>
        <option value="">Standard selling price</option>
        <option value="pos">Physical POS</option><option value="tables">Tables</option>
        <option value="talabat">Talabat</option><option value="whatsapp">WhatsApp</option><option value="delivery">Delivery</option>
      </select></label>
    </fieldset>
    <section className="border rounded-lg p-4 space-y-4">
      <h2 className="text-lg font-semibold">Configure a rule</h2>
      <p className="text-sm">Rules use the selected tenant or branch scope across channels. Activating a rule only changes recommendations.</p>
      <fieldset disabled={busy || !allowed} className="grid md:grid-cols-3 gap-3">
        <label>Rule target<select className={inputClass} value={target} onChange={e => {setTarget(e.target.value); setTargetId('');}}>
          <option value="scope">Scope default</option><option value="category">Category</option><option value="product">Product</option>
        </select></label>
        {target !== 'scope' && <label>Target<select aria-label="Rule target item" className={inputClass} value={targetId} onChange={e => setTargetId(e.target.value)}>
          <option value="">Select {target}</option>
          {(target === 'category' ? catalogue.data?.categories ?? [] : products).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>}
        <label>Markup (%)<input className={inputClass} inputMode="decimal" value={markup} onChange={e => setMarkup(e.target.value)} /></label>
        <label>Rounding<select className={inputClass} value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
          <option value="nearest_half_up">Nearest 25 fils (halfway up)</option><option value="ceil">Always round up to 25 fils</option>
        </select></label>
        <label className="md:col-span-2">Policy reason<input className={inputClass} maxLength={500} value={ruleReason} onChange={e => setRuleReason(e.target.value)} /></label>
      </fieldset>
      <Button disabled={busy || !allowed || ruleReason.trim().length < 3 || (target !== 'scope' && !targetId)} onClick={() => {
        const key = JSON.stringify(['rule', scope, target, targetId, markup, mode, ruleReason]);
        void run(key, async operation => {
          await setPricingRule(tenant, branch || null, target === 'category' ? targetId : null,
            target === 'product' ? targetId : null, markup, mode, ruleReason, operation);
          clearPreview(); await refresh();
        }, 'Rule activated. Preview prices before applying changes.');
      }}>Activate rule</Button>
      <ul className="space-y-2">{rules.map(rule => <li key={rule.id} className="border-t pt-2 flex flex-wrap gap-3 items-center">
        <span>{rule.product_id ? `Product ${products.find(p => p.id === rule.product_id)?.name ?? rule.product_id}` :
          rule.category_id ? `Category ${catalogue.data?.categories.find(c => c.id === rule.category_id)?.name ?? rule.category_id}` : 'Scope default'}
          {' · '}{rule.branch_id ? context.branches.find(b => b.id === rule.branch_id)?.name ?? 'Branch' : 'Tenant'}
          {' · '}{formatMarkup(rule.markup_basis_points)}{' · '}{rule.rounding_mode === 'ceil' ? 'Round up' : 'Nearest 25 fils'}</span>
        <Button variant="outline" disabled={busy || ruleReason.trim().length < 3 || (!global && rule.branch_id !== branch)} onClick={() => void run(
          JSON.stringify(['deactivate', tenant, rule.id, ruleReason]), async operation => {
            await deactivatePricingRule(tenant, rule.id, ruleReason, operation); clearPreview(); await refresh();
          }, 'Rule deactivated. Inherited rules now determine recommendations.')}>Deactivate</Button>
      </li>)}</ul>
      {!rules.length && <p className="text-sm">No configured rules in this scope. The 33% default applies.</p>}
    </section>
    <section className="border rounded-lg p-4 space-y-4">
      <h2 className="text-lg font-semibold">Review selling prices</h2>
      <label className="block">Find products<input className={inputClass} value={search} disabled={busy} onChange={e => {setSearch(e.target.value); setSelected([]); clearPreview();}} /></label>
      <p className="text-sm">Showing up to 100 matching products. Apply at most 100 per batch.</p>
      <fieldset disabled={busy || !allowed} className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-64 overflow-auto">
        {products.map(p => <label key={p.id} className="flex gap-2 items-center p-2 border rounded">
          <input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.includes(p.id)} onChange={e => {
            setSelected(e.target.checked ? [...selected, p.id] : selected.filter(id => id !== p.id)); clearPreview();
          }} />{p.name}</label>)}
      </fieldset>
      {!catalogue.isLoading && !products.length && <p>No matching active products.</p>}
      <Button disabled={busy || !allowed || !selected.length || !!catalogue.error} onClick={() => void run('preview', async () => {
        const result = await previewPricing(tenant, branch || null, (channel || null) as PricingChannel, selected);
        setPreviews(result); setPreviewedAt(new Date().toLocaleString('en-BH'));
      })}>Preview selected prices</Button>
      {previews.length > 0 && <>
        <p className="text-sm">Preview received {previewedAt}. Manual selling prices below will be replaced only when you apply.</p>
        <div className="overflow-x-auto"><table className="w-full text-sm text-left">
          <thead><tr>{['Product','Source cost','Current price','Markup','Raw target','Rounding adjustment','Proposed price','Rule'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead>
          <tbody>{previews.map(p => <tr key={p.product_id} className="border-t">
            <td className="p-2">{products.find(product => product.id === p.product_id)?.name ?? p.product_id}</td>
            <td className="p-2">{formatPricingFils(p.cost_fils)}<small className="block">{p.cost_source.replaceAll('_', ' ')}</small></td>
            <td className="p-2">{formatPricingFils(p.current_selling_price_fils)}</td><td className="p-2">{formatMarkup(p.markup_basis_points)}</td>
            <td className="p-2">{formatRawPrice(p.raw_price_numerator)}</td><td className="p-2">{formatRawPrice(p.rounding_adjustment_numerator)}</td>
            <td className="p-2 font-semibold">{formatPricingFils(p.rounded_price_fils)}</td><td className="p-2">{p.rule_scope.replaceAll('_',' ')}</td>
          </tr>)}</tbody></table></div>
        <label className="block">Repricing reason<input aria-label="Repricing reason" disabled={busy} className={inputClass} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <Button disabled={busy || !allowed || reason.trim().length < 3} onClick={() => void run(
          JSON.stringify(['apply', scope, previews, reason]), async operation => {
            await applyPricing(tenant, branch || null, (channel || null) as PricingChannel, previews, reason, operation);
            setPreviews([]); setSelected([]); await refresh();
          }, 'Reviewed prices applied. Historical sales retain their original prices and costs.')}>Apply reviewed prices</Button>
      </>}
      {busy && <p>Processing pricing request…</p>}
    </section>
  </main>;
}
