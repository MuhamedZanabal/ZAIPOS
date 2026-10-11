import { describe, expect, it } from "vitest";
import { enabledPaymentMethods, initialWizardState, loadWizard, readSetupStatus, saveWizard, starterCatalog, staffRolesFor, validateStep, type WizardState } from "./setupWizard";
import { BUSINESS_MODES } from "./business-modes";

const ready = (): WizardState => ({
  ...initialWizardState(),
  mode: "CAFE",
  basics: { businessName: "Seef Café", branchName: "Seef", currency: "BHD", vatRate: 10, trn: "" },
  account: { email: "owner@cafe.bh", password: "longenough" },
});

function memory() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
}

describe("setup wizard validation", () => {
  it("requires a business type", () => {
    expect(validateStep(0, initialWizardState())).toEqual(["Choose a business type"]);
    expect(validateStep(0, ready())).toEqual([]);
  });

  it("validates basics: name, branch, VAT range and 15-digit TRN", () => {
    expect(validateStep(1, ready())).toEqual([]);
    const s = ready();
    s.basics = { ...s.basics, businessName: " ", branchName: "", vatRate: 120, trn: "123" };
    expect(validateStep(1, s)).toEqual([
      "Business name is required",
      "First branch name is required",
      "VAT must be between 0 and 100%",
      "VAT registration number (TRN) must be 15 digits",
    ]);
    s.basics = { ...ready().basics, trn: "200012345600003" };
    expect(validateStep(1, s)).toEqual([]);
  });

  it("asks for the owner login only in local setup", () => {
    const s = ready();
    s.account = { email: "", password: "short" };
    expect(validateStep(1, s)).toEqual([]);
    expect(validateStep(1, s, { local: true })).toEqual(["Owner email or login name is required", "Owner password must be at least 8 characters"]);
  });

  it("validates included sample items only", () => {
    const s = ready();
    s.catalog = { useSamples: true, items: [{ key: "a", name: "", category: "X", price: -1, unit: "unit", include: true }, { key: "b", name: "", category: "X", price: -1, unit: "unit", include: false }] };
    expect(validateStep(2, s).length).toBe(2);
    s.catalog.useSamples = false;
    expect(validateStep(2, s)).toEqual([]);
  });

  it("needs at least one payment method", () => {
    const s = ready();
    s.payments.methods = [];
    expect(validateStep(3, s)).toEqual(["Choose at least one payment method"]);
  });

  it("validates staff logins and skips already-created members", () => {
    const s = ready();
    s.staff = [
      { key: "1", name: "A", email: "a@x.bh", password: "123", role: "cashier" },
      { key: "2", name: "B", email: "a@x.bh", password: "password1", role: "waiter" },
      { key: "3", name: "C", email: "c@x.bh", password: "", role: "kitchen", created: true },
    ];
    expect(validateStep(4, s)).toEqual(["a@x.bh: password must be at least 8 characters", "a@x.bh: added twice"]);
    expect(validateStep(4, { ...s, staff: [] })).toEqual([]);
  });
});

describe("starter catalogs", () => {
  it.each(BUSINESS_MODES)("%s has clearly-marked sample items", (mode) => {
    const items = starterCatalog(mode);
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items.every((item) => item.name.endsWith("(sample)") && item.include)).toBe(true);
  });
  it("supermarket includes barcoded and weighed items", () => {
    const items = starterCatalog("SUPERMARKET");
    expect(items.some((item) => item.unit === "kg")).toBe(true);
    expect(items.filter((item) => item.barcode).every((item) => /^\d{13}$/.test(item.barcode!))).toBe(true);
  });
  it("offers staff roles that fit the type", () => {
    expect(staffRolesFor("RESTAURANT")).toContain("kitchen");
    expect(staffRolesFor("SUPERMARKET")).not.toContain("waiter");
  });
});

describe("resume", () => {
  it("round-trips progress but never stores passwords", () => {
    const store = memory();
    const s = { ...ready(), step: 3, staff: [{ key: "1", name: "A", email: "a@x.bh", password: "secret123", role: "cashier" as const }] };
    saveWizard(s, store);
    expect([...store.data.values()].join()).not.toContain("secret123");
    expect([...store.data.values()].join()).not.toContain("longenough");
    const loaded = loadWizard(store)!;
    expect(loaded.step).toBe(3);
    expect(loaded.mode).toBe("CAFE");
    expect(loaded.staff[0].password).toBe("");
  });
  it("ignores corrupt drafts", () => {
    const store = memory();
    store.setItem("zaipos.setupWizard.v1", "{nope");
    expect(loadWizard(store)).toBeNull();
  });
  it("reads tenant setup status and payment methods", () => {
    expect(readSetupStatus({ setup: { status: "in_progress", step: 4 } })).toEqual({ status: "in_progress", step: 4 });
    expect(readSetupStatus({})).toBeNull();
    expect(enabledPaymentMethods({ payment_methods: ["cash", "qr", "bogus"] })).toEqual(["cash", "qr"]);
    expect(enabledPaymentMethods(null)).toEqual(["cash", "card", "qr", "transfer"]);
  });
});
