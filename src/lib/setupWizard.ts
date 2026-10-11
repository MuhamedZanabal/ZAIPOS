import { BUSINESS_MODE_INFO, type BusinessMode } from "@/lib/business-modes";
import type { PayMethod } from "@/modules/pos/paymentAllocations";

export const WIZARD_STEPS = [
  { key: "type", label: "Business type" },
  { key: "basics", label: "Basics" },
  { key: "catalog", label: "Starter catalog" },
  { key: "payments", label: "Payments & receipt" },
  { key: "staff", label: "Staff" },
  { key: "finish", label: "First sale" },
] as const;
export type WizardStepKey = (typeof WIZARD_STEPS)[number]["key"];
/** Steps 0-1 run before the business exists; the rest run signed in as the owner. */
export const FIRST_IN_APP_STEP = 2;

export type StarterItem = {
  key: string;
  name: string;
  category: string;
  price: number;
  unit: "unit" | "kg";
  barcode?: string;
  include: boolean;
};

export type StaffDraft = { key: string; name: string; email: string; password: string; role: "cashier" | "waiter" | "kitchen" | "inventory" | "manager"; created?: boolean };

export type WizardState = {
  step: number;
  mode: BusinessMode | null;
  basics: { businessName: string; branchName: string; currency: "BHD"; vatRate: number; trn: string };
  account: { email: string; password: string };
  catalog: { useSamples: boolean; items: StarterItem[] };
  payments: { methods: PayMethod[]; receiptHeader: string; receiptFooter: string };
  staff: StaffDraft[];
};

export const ALL_PAYMENT_METHODS: PayMethod[] = ["cash", "card", "qr", "transfer"];

export function initialWizardState(): WizardState {
  return {
    step: 0,
    mode: null,
    basics: { businessName: "", branchName: "Main Branch", currency: "BHD", vatRate: 10, trn: "" },
    account: { email: "", password: "" },
    catalog: { useSamples: true, items: [] },
    payments: { methods: ["cash", "card", "qr"], receiptHeader: "", receiptFooter: "Thank you for your visit!" },
    staff: [],
  };
}

type Seed = [name: string, category: string, price: number, unit?: "unit" | "kg", barcode?: string];

const STARTER: Record<BusinessMode, Seed[]> = {
  RESTAURANT: [
    ["Chicken Machboos", "Mains", 2.8], ["Lamb Biryani", "Mains", 3.2], ["Grilled Hammour", "Mains", 4.5],
    ["Hummus", "Starters", 0.9], ["Fattoush", "Starters", 1.1],
    ["Fresh Lemon Mint", "Drinks", 1.0], ["Soft Drink", "Drinks", 0.3, "unit", "5449000000996"],
    ["Umm Ali", "Desserts", 1.4],
  ],
  CAFE: [
    ["Karak Tea", "Hot Drinks", 0.2], ["Cappuccino", "Hot Drinks", 1.2], ["Spanish Latte", "Hot Drinks", 1.6],
    ["Iced Americano", "Cold Drinks", 1.4], ["Fresh Orange Juice", "Cold Drinks", 1.0],
    ["Cheese Croissant", "Bakery", 0.7], ["Halloumi Sandwich", "Food", 1.5],
  ],
  SUPERMARKET: [
    ["Drinking Water 1.5L", "Beverages", 0.2, "unit", "6291003000014"],
    ["Fresh Milk 1L", "Dairy", 0.65, "unit", "6291003000021"],
    ["Basmati Rice 5kg", "Pantry", 4.95, "unit", "6291003000038"],
    ["Potato Chips 45g", "Snacks", 0.25, "unit", "6291003000045"],
    ["Tomatoes", "Fruit & Veg", 0.6, "kg"], ["Bananas", "Fruit & Veg", 0.75, "kg"],
    ["Dishwashing Liquid 750ml", "Household", 1.25, "unit", "6291003000052"],
  ],
  RETAIL: [
    ["Phone Charger USB-C", "Electronics", 4.5, "unit", "6291004000013"],
    ["Earphones", "Electronics", 6.0, "unit", "6291004000020"],
    ["Notebook A5", "Stationery", 0.8, "unit", "6291004000037"],
    ["Ballpoint Pen (Blue)", "Stationery", 0.15, "unit", "6291004000044"],
    ["Gift Bag", "Gifts", 0.5, "unit", "6291004000051"],
  ],
};

/** Sample items for a business type. Marked "(sample)" so they're easy to spot and remove. */
export function starterCatalog(mode: BusinessMode): StarterItem[] {
  return STARTER[mode].map(([name, category, price, unit = "unit", barcode], index) => ({
    key: `${mode.toLowerCase()}-${index}`,
    name: `${name} (sample)`,
    category,
    price,
    unit,
    barcode,
    include: true,
  }));
}

export function staffRolesFor(mode: BusinessMode | null): StaffDraft["role"][] {
  return mode ? BUSINESS_MODE_INFO[mode].staffRoles : ["cashier", "manager"];
}

const TRN = /^\d{15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns human-readable problems; empty means the step can be left. */
export function validateStep(step: number, state: WizardState, options: { local?: boolean } = {}): string[] {
  const errors: string[] = [];
  switch (WIZARD_STEPS[step]?.key) {
    case "type":
      if (!state.mode) errors.push("Choose a business type");
      break;
    case "basics": {
      const { businessName, branchName, vatRate, trn } = state.basics;
      if (!businessName.trim()) errors.push("Business name is required");
      if (businessName.trim().length > 80) errors.push("Business name must be 80 characters or fewer");
      if (!branchName.trim()) errors.push("First branch name is required");
      if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) errors.push("VAT must be between 0 and 100%");
      if (trn.trim() && !TRN.test(trn.trim())) errors.push("VAT registration number (TRN) must be 15 digits");
      if (options.local) {
        if (!state.account.email.trim()) errors.push("Owner email or login name is required");
        if (state.account.password.length < 8) errors.push("Owner password must be at least 8 characters");
      }
      break;
    }
    case "catalog":
      if (state.catalog.useSamples) {
        for (const item of state.catalog.items.filter((entry) => entry.include)) {
          if (!item.name.trim()) errors.push("Every sample item needs a name");
          if (!Number.isFinite(item.price) || item.price < 0) errors.push(`${item.name || "Item"}: price must be 0 or more`);
        }
      }
      break;
    case "payments":
      if (state.payments.methods.length === 0) errors.push("Choose at least one payment method");
      if (state.payments.receiptHeader.length > 200 || state.payments.receiptFooter.length > 200) errors.push("Receipt text must be 200 characters or fewer");
      break;
    case "staff": {
      const seen = new Set<string>();
      for (const member of state.staff) {
        const email = member.email.trim().toLowerCase();
        if (!email) errors.push("Every staff member needs a login (email)");
        else if (!options.local && !EMAIL.test(email)) errors.push(`${email}: enter a valid email`);
        if (!member.created && member.password.length < 8) errors.push(`${email || "Staff"}: password must be at least 8 characters`);
        if (seen.has(email)) errors.push(`${email}: added twice`);
        seen.add(email);
      }
      break;
    }
    default:
      break;
  }
  return [...new Set(errors)];
}

const STORAGE_KEY = "zaipos.setupWizard.v1";

/** Passwords are never written to storage. */
export function saveWizard(state: WizardState, storage: Pick<Storage, "setItem"> = localStorage) {
  const safe: WizardState = {
    ...state,
    account: { email: state.account.email, password: "" },
    staff: state.staff.map((member) => ({ ...member, password: "" })),
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(safe));
}

export function loadWizard(storage: Pick<Storage, "getItem"> = localStorage): WizardState | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WizardState>;
    const base = initialWizardState();
    return {
      ...base,
      ...parsed,
      basics: { ...base.basics, ...parsed.basics, currency: "BHD" },
      account: { ...base.account, ...parsed.account, password: "" },
      catalog: { ...base.catalog, ...parsed.catalog },
      payments: { ...base.payments, ...parsed.payments },
      staff: (parsed.staff ?? []).map((member) => ({ ...member, password: "" })),
      step: Math.max(0, Math.min(WIZARD_STEPS.length - 1, Number(parsed.step) || 0)),
    };
  } catch {
    return null;
  }
}

export function clearWizard(storage: Pick<Storage, "removeItem"> = localStorage) {
  storage.removeItem(STORAGE_KEY);
}

/** Setup progress kept on the tenant so it survives a restart or another device. */
export type SetupStatus = { status: "in_progress" | "completed"; step: number };

export function readSetupStatus(receiptConfig: unknown): SetupStatus | null {
  const setup = (receiptConfig as { setup?: Partial<SetupStatus> } | null)?.setup;
  if (!setup || (setup.status !== "in_progress" && setup.status !== "completed")) return null;
  return { status: setup.status, step: Number(setup.step) || FIRST_IN_APP_STEP };
}

/** Payment methods enabled for this business (all methods for businesses set up before the wizard). */
export function enabledPaymentMethods(receiptConfig: unknown): PayMethod[] {
  const methods = (receiptConfig as { payment_methods?: unknown } | null)?.payment_methods;
  if (!Array.isArray(methods)) return ALL_PAYMENT_METHODS;
  const valid = ALL_PAYMENT_METHODS.filter((method) => methods.includes(method));
  return valid.length ? valid : ALL_PAYMENT_METHODS;
}
