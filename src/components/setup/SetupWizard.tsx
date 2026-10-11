import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Coffee, Loader2, Plus, ShoppingBasket, Store, Trash2, UtensilsCrossed } from "lucide-react";
import { BUSINESS_MODE_INFO, BUSINESS_MODES, type BusinessMode } from "@/lib/business-modes";
import {
  ALL_PAYMENT_METHODS,
  FIRST_IN_APP_STEP,
  WIZARD_STEPS,
  initialWizardState,
  loadWizard,
  saveWizard,
  staffRolesFor,
  starterCatalog,
  validateStep,
  type StaffDraft,
  type WizardState,
} from "@/lib/setupWizard";
import { paymentMethodLabel } from "@/modules/pos/PaymentDialog";

const MODE_ICONS: Record<BusinessMode, typeof Store> = {
  RESTAURANT: UtensilsCrossed,
  CAFE: Coffee,
  SUPERMARKET: ShoppingBasket,
  RETAIL: Store,
};

export type SetupWizardProps = {
  /** Local first-owner setup asks for the owner login on the basics step. */
  local?: boolean;
  /** Pre-business phase: creates the business from steps 1-2. */
  onCreateBusiness?: (state: WizardState) => Promise<void>;
  /** In-app phase: persists one step; throws to stay on the step. */
  onSaveStep?: (step: number, state: WizardState) => Promise<WizardState | void>;
  onFinish?: (state: WizardState) => Promise<void>;
  onExit?: () => void;
  exitLabel?: string;
  initial?: WizardState | null;
};

const field = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-cyan-600 focus:ring-1 focus:ring-cyan-600";

export function SetupWizard({ local, onCreateBusiness, onSaveStep, onFinish, onExit, exitLabel, initial }: SetupWizardProps) {
  const [state, setState] = useState<WizardState>(() => initial ?? loadWizard() ?? initialWizardState());
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const inApp = !onCreateBusiness;
  const step = inApp ? Math.max(state.step, FIRST_IN_APP_STEP) : Math.min(state.step, FIRST_IN_APP_STEP - 1);

  useEffect(() => { saveWizard(state); }, [state]);

  const update = (patch: Partial<WizardState>) => setState((current) => ({ ...current, ...patch }));
  const go = (next: number) => { setErrors([]); setState((current) => ({ ...current, step: next })); };

  const chooseMode = (mode: BusinessMode) => {
    setState((current) => ({
      ...current,
      mode,
      // New type, new samples; keep edits if the type didn't change.
      catalog: current.mode === mode && current.catalog.items.length ? current.catalog : { useSamples: true, items: starterCatalog(mode) },
      staff: current.staff.filter((member) => staffRolesFor(mode).includes(member.role)),
    }));
  };

  const next = async () => {
    const problems = validateStep(step, state, { local });
    setErrors(problems);
    if (problems.length) return;
    setBusy(true);
    try {
      if (!inApp && step === FIRST_IN_APP_STEP - 1) {
        await onCreateBusiness!(state);
        setState((current) => ({ ...current, step: FIRST_IN_APP_STEP, account: { ...current.account, password: "" } }));
        return;
      }
      if (inApp && step === WIZARD_STEPS.length - 1) {
        await onFinish?.(state);
        return;
      }
      const saved = (await onSaveStep?.(step, state)) ?? state;
      setState({ ...saved, step: step + 1 });
      setErrors([]);
    } catch (error) {
      setErrors([(error as Error).message || "Something went wrong. Try again."]);
    } finally {
      setBusy(false);
    }
  };

  const canGoBack = inApp ? step > FIRST_IN_APP_STEP : step > 0;
  const info = state.mode ? BUSINESS_MODE_INFO[state.mode] : null;

  return (
    <div className="w-full max-w-3xl rounded-2xl bg-white p-6 text-slate-900 shadow-2xl sm:p-8" data-testid="setup-wizard">
      <ol className="mb-6 grid grid-cols-6 gap-1" aria-label="Setup progress">
        {WIZARD_STEPS.map((entry, index) => {
          const done = index < step;
          const current = index === step;
          return (
            <li key={entry.key} aria-current={current ? "step" : undefined} className="flex flex-col items-center gap-1 text-center">
              <span className={`grid h-8 w-8 place-items-center rounded-full text-sm font-bold ${done ? "bg-emerald-500 text-white" : current ? "bg-cyan-600 text-white" : "bg-slate-200 text-slate-500"}`}>
                {done ? <Check className="h-4 w-4" /> : index + 1}
              </span>
              <span className={`text-[11px] leading-tight ${current ? "font-semibold text-slate-900" : "text-slate-500"}`}>{entry.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="mb-1 text-xs font-bold uppercase tracking-[0.16em] text-cyan-700">Step {step + 1} of {WIZARD_STEPS.length}</p>

      {WIZARD_STEPS[step].key === "type" && (
        <section>
          <h1 className="mb-1 text-2xl font-bold">What kind of business is this?</h1>
          <p className="mb-5 text-slate-600">ZAIPOS shows the screens that fit your business. You can change this later in Settings.</p>
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Business type">
            {BUSINESS_MODES.map((mode) => {
              const Icon = MODE_ICONS[mode];
              const selected = state.mode === mode;
              return (
                <button key={mode} type="button" role="radio" aria-checked={selected} data-mode={mode} onClick={() => chooseMode(mode)}
                  className={`flex gap-3 rounded-xl border-2 p-4 text-left transition ${selected ? "border-cyan-600 bg-cyan-50" : "border-slate-200 hover:border-cyan-400"}`}>
                  <Icon className="mt-0.5 h-7 w-7 shrink-0 text-cyan-700" />
                  <span>
                    <span className="block font-semibold">{BUSINESS_MODE_INFO[mode].label}</span>
                    <span className="block text-sm text-slate-600">{BUSINESS_MODE_INFO[mode].tagline}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {WIZARD_STEPS[step].key === "basics" && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Business basics</h1>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block"><span className="mb-1 block text-sm font-medium">Business name</span>
              <input className={field} maxLength={80} value={state.basics.businessName} onChange={(e) => update({ basics: { ...state.basics, businessName: e.target.value } })} /></label>
            <label className="block"><span className="mb-1 block text-sm font-medium">First branch</span>
              <input className={field} maxLength={80} value={state.basics.branchName} onChange={(e) => update({ basics: { ...state.basics, branchName: e.target.value } })} /></label>
            <label className="block"><span className="mb-1 block text-sm font-medium">Currency</span>
              <input className={`${field} bg-slate-100`} value="BHD — Bahraini dinar" readOnly aria-readonly /></label>
            <label className="block"><span className="mb-1 block text-sm font-medium">VAT rate (%)</span>
              <input className={field} type="number" min={0} max={100} step="0.5" value={state.basics.vatRate} onChange={(e) => update({ basics: { ...state.basics, vatRate: Number(e.target.value) } })} /></label>
            <label className="block sm:col-span-2"><span className="mb-1 block text-sm font-medium">VAT registration number (TRN) <span className="font-normal text-slate-500">— optional, 15 digits</span></span>
              <input className={field} inputMode="numeric" maxLength={15} value={state.basics.trn} onChange={(e) => update({ basics: { ...state.basics, trn: e.target.value.replace(/\D/g, "") } })} /></label>
          </div>
          {local && (
            <div className="grid gap-4 border-t border-slate-200 pt-4 sm:grid-cols-2">
              <label className="block"><span className="mb-1 block text-sm font-medium">Owner email</span>
                <input className={field} type="email" autoComplete="username" value={state.account.email} onChange={(e) => update({ account: { ...state.account, email: e.target.value } })} /></label>
              <label className="block"><span className="mb-1 block text-sm font-medium">Owner password</span>
                <input className={field} type="password" autoComplete="new-password" value={state.account.password} onChange={(e) => update({ account: { ...state.account, password: e.target.value } })} /></label>
            </div>
          )}
        </section>
      )}

      {WIZARD_STEPS[step].key === "catalog" && (
        <CatalogStep state={state} update={update} />
      )}

      {WIZARD_STEPS[step].key === "payments" && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Payments and receipt</h1>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Payment methods you accept</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ALL_PAYMENT_METHODS.map((method) => {
                const on = state.payments.methods.includes(method);
                return (
                  <label key={method} className={`flex items-center gap-2 rounded-lg border-2 px-3 py-2 ${on ? "border-cyan-600 bg-cyan-50" : "border-slate-200"}`}>
                    <input type="checkbox" checked={on} onChange={() => update({ payments: { ...state.payments, methods: on ? state.payments.methods.filter((m) => m !== method) : [...state.payments.methods, method] } })} />
                    {paymentMethodLabel(method)}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <label className="block"><span className="mb-1 block text-sm font-medium">Receipt header</span>
            <textarea className={field} rows={2} maxLength={200} placeholder={state.basics.businessName || "Shop name, address, phone"} value={state.payments.receiptHeader} onChange={(e) => update({ payments: { ...state.payments, receiptHeader: e.target.value } })} /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium">Receipt footer</span>
            <textarea className={field} rows={2} maxLength={200} value={state.payments.receiptFooter} onChange={(e) => update({ payments: { ...state.payments, receiptFooter: e.target.value } })} /></label>
        </section>
      )}

      {WIZARD_STEPS[step].key === "staff" && (
        <StaffStep state={state} update={update} local={local} />
      )}

      {WIZARD_STEPS[step].key === "finish" && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">You're ready for a first test sale</h1>
          <p className="text-slate-600">{state.basics.businessName || "Your business"} is set up as a <strong>{info?.label ?? "business"}</strong>.</p>
          <ol className="list-decimal space-y-2 pl-5 text-slate-700">
            <li>Open the register with the cash in the drawer (Cash Register).</li>
            <li>{info && (state.mode === "SUPERMARKET" || state.mode === "RETAIL") ? "Scan a barcode or tap a sample item. Items sold by weight ask for the kg." : "Tap a sample item to add it to the order."}</li>
            <li>Press Charge, pick a payment method and complete the sale.</li>
          </ol>
          <p className="text-sm text-slate-500">Sample items are marked "(sample)". Edit or delete them in Products whenever you like.</p>
        </section>
      )}

      {errors.length > 0 && (
        <ul role="alert" className="mt-5 space-y-1 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {errors.map((error) => <li key={error}>{error}</li>)}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {canGoBack && (
            <button type="button" onClick={() => go(step - 1)} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700 disabled:opacity-50">
              <ChevronLeft className="h-4 w-4" /> Back
            </button>
          )}
          {onExit && (
            <button type="button" onClick={onExit} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-500 underline-offset-2 hover:underline">{exitLabel ?? "Finish later"}</button>
          )}
        </div>
        <button type="button" onClick={() => void next()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-5 py-2.5 font-bold text-white hover:bg-cyan-700 disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {!inApp && step === FIRST_IN_APP_STEP - 1 ? "Create business" : step === WIZARD_STEPS.length - 1 ? "Start first test sale" : "Next"}
          {!busy && <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function CatalogStep({ state, update }: { state: WizardState; update: (patch: Partial<WizardState>) => void }) {
  const items = useMemo(() => (state.catalog.items.length || !state.mode ? state.catalog.items : starterCatalog(state.mode)), [state.catalog.items, state.mode]);
  const setItems = (next: WizardState["catalog"]["items"]) => update({ catalog: { ...state.catalog, items: next } });
  return (
    <section className="space-y-3">
      <h1 className="text-2xl font-bold">Starter catalog</h1>
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" checked={state.catalog.useSamples} onChange={(e) => update({ catalog: { items, useSamples: e.target.checked } })} />
        Add sample items so I can try a sale right away
      </label>
      {state.catalog.useSamples && (
        <>
          <p className="text-sm text-slate-600">These are <strong>samples</strong> with 50 in opening stock. Edit names and prices, untick what you don't want, or delete them later in Products.</p>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-slate-500"><tr><th className="p-2">Add</th><th className="p-2">Item</th><th className="p-2">Category</th><th className="p-2">Price (BHD)</th><th className="p-2">Unit</th></tr></thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={item.key} className="border-t border-slate-100" data-testid="starter-item">
                    <td className="p-2"><input type="checkbox" aria-label={`Include ${item.name}`} checked={item.include} onChange={(e) => setItems(items.map((it, i) => (i === index ? { ...it, include: e.target.checked } : it)))} /></td>
                    <td className="p-2"><input className="w-full rounded border border-slate-200 px-2 py-1" value={item.name} onChange={(e) => setItems(items.map((it, i) => (i === index ? { ...it, name: e.target.value } : it)))} />{item.barcode && <span className="mt-0.5 block text-[11px] text-slate-500">Barcode {item.barcode}</span>}</td>
                    <td className="p-2 text-slate-600">{item.category}</td>
                    <td className="p-2"><input className="w-24 rounded border border-slate-200 px-2 py-1 tabular-nums" type="number" min={0} step="0.001" value={item.price} onChange={(e) => setItems(items.map((it, i) => (i === index ? { ...it, price: Number(e.target.value) } : it)))} /></td>
                    <td className="p-2 text-slate-600">{item.unit === "kg" ? "per kg" : "each"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function StaffStep({ state, update, local }: { state: WizardState; update: (patch: Partial<WizardState>) => void; local?: boolean }) {
  const roles = staffRolesFor(state.mode);
  const setStaff = (staff: StaffDraft[]) => update({ staff });
  return (
    <section className="space-y-3">
      <h1 className="text-2xl font-bold">Staff <span className="text-base font-normal text-slate-500">(optional)</span></h1>
      <p className="text-slate-600">Give each person their own login so sales are tracked per person. You can skip this and add staff later in Settings → Users.</p>
      {state.staff.map((member, index) => (
        <div key={member.key} className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_1fr_1fr_auto_auto]" data-testid="staff-row">
          <input className={field} aria-label="Staff name" placeholder="Name" value={member.name} disabled={member.created} onChange={(e) => setStaff(state.staff.map((m, i) => (i === index ? { ...m, name: e.target.value } : m)))} />
          <input className={field} aria-label="Staff login" placeholder={local ? "Login (email or name)" : "Email"} value={member.email} disabled={member.created} onChange={(e) => setStaff(state.staff.map((m, i) => (i === index ? { ...m, email: e.target.value } : m)))} />
          <input className={field} aria-label="Staff password" type="password" placeholder={member.created ? "Created" : "Password (8+)"} value={member.password} disabled={member.created} onChange={(e) => setStaff(state.staff.map((m, i) => (i === index ? { ...m, password: e.target.value } : m)))} />
          <select className={field} aria-label="Staff role" value={member.role} disabled={member.created} onChange={(e) => setStaff(state.staff.map((m, i) => (i === index ? { ...m, role: e.target.value as StaffDraft["role"] } : m)))}>
            {roles.map((role) => <option key={role} value={role}>{role[0].toUpperCase() + role.slice(1)}</option>)}
          </select>
          {member.created ? <span className="self-center text-sm font-semibold text-emerald-600">Added</span> : (
            <button type="button" aria-label="Remove staff member" className="rounded-lg border border-slate-200 px-3 text-slate-500" onClick={() => setStaff(state.staff.filter((_, i) => i !== index))}><Trash2 className="h-4 w-4" /></button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {roles.map((role) => (
          <button key={role} type="button" className="inline-flex items-center gap-1 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-cyan-500"
            onClick={() => setStaff([...state.staff, { key: `${role}-${Date.now()}`, name: "", email: "", password: "", role }])}>
            <Plus className="h-3.5 w-3.5" /> Add {role}
          </button>
        ))}
      </div>
    </section>
  );
}
