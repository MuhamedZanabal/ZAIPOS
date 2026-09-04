# Bahrain-Native ZAIPOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert ZAIPOS to a Bahrain-native point-of-sale baseline and finish the repository-wide ZAIPOS rebrand before merging the approved result to `main`.

**Architecture:** Centralize Bahrain defaults in a small locale/config module, then adapt money/tax/payment/channel UI around those constants. Remove LatAm-specific integrations and demo data from runtime surfaces, keep only database-bound compatibility values that cannot be safely deleted, and add a migration for Bahrain channel/default support.

**Tech Stack:** React 18, TypeScript, Vite, Electron, Supabase/PostgreSQL, Vitest, ESLint.

**Spec:** `docs/superpowers/specs/2026-09-04-bahrain-native-zaipos-design.md`

## Global Constraints

- Product name is exactly `ZAIPOS`.
- UI language remains English.
- Default locale is `en-BH`.
- Default currency is `BHD` with exactly 3 displayed fraction digits.
- Default Bahrain VAT is 10%; zero-rated/exempt supplies remain possible.
- Default country calling code is `+973`; standard Bahrain subscriber numbers are 8 digits.
- Primary local digital payment method is BenefitPay.
- User-facing delivery channels are Talabat, WhatsApp, and in-house delivery.
- Do not invent undocumented BenefitPay or Talabat settlement/API behavior.
- Do not create new Rappi/Didi/Uber runtime data.
- Existing database enum compatibility values may remain only when PostgreSQL compatibility requires them; they must be hidden from Bahrain runtime UI.

---

### Task 1: Bahrain locale, money, VAT, and phone primitives

**Files:**
- Create: `src/lib/bahrain.ts`
- Create: `src/lib/bahrain.test.ts`
- Modify: `src/lib/format.ts`
- Modify: `src/modules/settings/BusinessSettings.tsx`

**Interfaces:**
- Produces: `BAHRAIN_LOCALE`, `BAHRAIN_CURRENCY`, `BAHRAIN_STANDARD_VAT`, `BAHRAIN_COUNTRY_CODE`, `BAHRAIN_PHONE_DIGITS`, `BHD_CASH_SHORTCUTS`, `normalizeBahrainPhone()`.
- Produces: `formatCurrency(n, currency?)` rendering BHD to 3 decimal places by default.

- [ ] **Step 1: Add failing tests for Bahrain constants and formatting**

```ts
import { describe, expect, it } from "vitest";
import { BAHRAIN_CURRENCY, BAHRAIN_STANDARD_VAT, normalizeBahrainPhone } from "./bahrain";
import { formatCurrency } from "./format";

describe("Bahrain defaults", () => {
  it("uses BHD and Bahrain VAT", () => {
    expect(BAHRAIN_CURRENCY).toBe("BHD");
    expect(BAHRAIN_STANDARD_VAT).toBe(10);
  });

  it("normalizes an 8 digit Bahrain number to +973", () => {
    expect(normalizeBahrainPhone("36001234")).toBe("+97336001234");
  });

  it("formats BHD to three decimals", () => {
    expect(formatCurrency(1.5)).toContain("1.500");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- src/lib/bahrain.test.ts`
Expected: FAIL because the Bahrain module/constants do not exist yet.

- [ ] **Step 3: Implement Bahrain constants and formatter**

Create `src/lib/bahrain.ts` with immutable Bahrain defaults and phone normalization. Update `format.ts` to default to `en-BH` + `BHD`, retaining tenant currency override while using the currency's normal precision and forcing three digits for BHD. Update Business Settings to default to BHD/10%, use English labels, and make BHD the first currency option.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- src/lib/bahrain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bahrain.ts src/lib/bahrain.test.ts src/lib/format.ts src/modules/settings/BusinessSettings.tsx
git commit -m "feat: make Bahrain the core locale and currency baseline"
```

### Task 2: Bahrain-native payments

**Files:**
- Modify: `src/modules/pos/PaymentDialog.tsx`
- Modify: `src/modules/pos/POS.tsx` only where payment method typing/persistence requires it
- Test: extend/add focused payment tests if existing test harness permits

**Interfaces:**
- Payment choices shown to users: `cash`, `card`, `benefitpay`, `bank_transfer`.
- If database/RPC storage supports only legacy generic strings, map BenefitPay to a stable persisted string without fabricating settlement verification.

- [ ] **Step 1: Add a failing test/assertion for Bahrain payment choices**
- [ ] **Step 2: Verify RED** with `npm test` against the focused payment test.
- [ ] **Step 3: Replace Transfer/QR presentation with BenefitPay and Bank Transfer, use BHD cash shortcuts `[0.5, 1, 5, 10, 20]`, remove whole-unit rounding, replace `$` adornments with `BHD`, and finish any residual English translation in this dialog.**
- [ ] **Step 4: Run focused payment tests and type/build checks.**
- [ ] **Step 5: Commit** with `feat: add Bahrain-native payment methods`.

### Task 3: Bahrain sales channels and integration hard cutover

**Files:**
- Modify: `src/lib/channels.ts`
- Modify: `src/modules/settings/Settings.tsx`
- Delete: `src/modules/settings/RappiSettings.tsx`
- Delete: `supabase/functions/_shared/rappi.ts`
- Delete: `supabase/functions/rappi-order-action/index.ts`
- Delete: `supabase/functions/rappi-sync-menu/index.ts`
- Delete: `supabase/functions/rappi-test-connection/index.ts`
- Delete: `supabase/functions/rappi-webhook/index.ts`
- Create: `supabase/migrations/20260904000100_bahrain_native_channels.sql`
- Modify generated Supabase types only if necessary for `talabat` enum visibility.

**Interfaces:**
- `CHANNELS` exposes `pos`, `tables`, `talabat`, `whatsapp`, `delivery`.
- Deprecated `rappi`, `didi`, `uber` enum values may remain in PostgreSQL but are not exposed by UI.

- [ ] **Step 1: Add a failing channel test asserting Talabat is exposed and Rappi/Didi/Uber are not.**
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Add `talabat` to the database enum safely (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`) and update UI/channel helpers.**
- [ ] **Step 4: Remove Rappi settings and edge-function code; remove imports/routes/settings entries that reference it.**
- [ ] **Step 5: Run migration validation, tests, lint, build.**
- [ ] **Step 6: Commit** with `feat: replace LatAm delivery channels with Bahrain channels`.

### Task 4: Bahrain demo presets and seed data

**Files:**
- Replace: `src/modules/settings/DemoPresets.tsx` preset data with Bahrain-oriented BHD examples
- Modify: `supabase/seed.sql`
- Modify/remove Colombia-specific demo migrations only by adding a forward migration; do not rewrite historical migration history unless the repo policy permits it
- Create: `supabase/migrations/20260904000200_bahrain_demo_defaults.sql` if tenant/demo defaults need forward correction

**Interfaces:**
- Demo businesses use BHD and 10% default VAT.
- Demo geography uses Bahrain locations.
- Default presets do not include Colombian alcohol/brand/location fixtures.

- [ ] **Step 1: Add a static fixture test that demo presets contain `BHD` and no `COP`, `Medellín`, `Cajicá`, `Antioqueño`, or Colombian beer fixtures.**
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Replace bakery/bar/ice-cream Colombia presets with Bahrain supermarket/cafeteria/bakery or restaurant presets using BHD-scale prices.**
- [ ] **Step 4: Update seed/default tenant values to Bahrain examples and +973 phones without rewriting already-applied historical migrations destructively.**
- [ ] **Step 5: Run tests and migration validation.**
- [ ] **Step 6: Commit** with `feat: replace Colombia demos with Bahrain data`.

### Task 5: Bahrainize customer, address, receipt, WhatsApp, AI, report, and onboarding surfaces

**Files:**
- Modify as required after residual audit: `src/modules/customers/Customers.tsx`, `src/modules/delivery/Delivery.tsx`, `src/modules/settings/ReceiptSettings.tsx`, `src/modules/settings/WhatsAppSettings.tsx`, `src/pages/Onboarding.tsx`, `src/pages/QRMenu.tsx`, `supabase/functions/ai-order-agent/index.ts`, `supabase/functions/send-whatsapp-message/index.ts`, report/export helpers, and docs.

**Interfaces:**
- Phone examples/normalization prefer +973.
- Address examples use Bahrain governorates/areas rather than Colombia.
- Receipts/reports render BHD via shared formatter.
- AI/business copy refers to Bahrain ecosystem where country context is needed.

- [ ] **Step 1: Add focused failing tests for Bahrain phone/address defaults where practical.**
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Replace Colombia/LatAm examples and country-specific prompt assumptions with Bahrain examples.**
- [ ] **Step 4: Ensure reports/receipts/CSV do not hardcode `$`, COP, zero-decimal money, or Colombia locale.**
- [ ] **Step 5: Run focused tests, lint, and build.**
- [ ] **Step 6: Commit** with `feat: Bahrainize customer and operational surfaces`.

### Task 6: Complete ZAIPOS repository-wide rebrand and packaging assets

**Files:**
- Modify: `package-lock.json`, `README.md`, docs containing product identity, deployment docs/config
- Modify/create binary assets as available: `public/icon.png`, `public/icon.ico`, `public/icon.icns`, `public/favicon.png`, `public/apple-touch-icon.png`, `public/pwa-192x192.png`, `public/pwa-512x512.png`, `public/pwa-maskable-512x512.png`
- Verify: `package.json`, `electron-builder.config.json`, `index.html`, `vite.config.ts`, `public/icon-source.svg`

- [ ] **Step 1: Scan for `S360T|POS360T|POS S360T|poss360t`.**
- [ ] **Step 2: Replace every non-compatibility legacy brand reference with ZAIPOS; regenerate package-lock root metadata.**
- [ ] **Step 3: Ensure Electron references point to assets that actually exist.**
- [ ] **Step 4: Re-run legacy-brand scan and require zero unexplained matches.**
- [ ] **Step 5: Commit** with `chore: complete ZAIPOS repository rebrand`.

### Task 7: Final audit, CI attempt, and merge to main

**Files:**
- No new functional files unless audit finds defects.
- Update PR #1 description with Bahrain scope and verification evidence.

- [ ] **Step 1: Run residual Bahrain/LatAm audit** for `COP|es-CO|Colombia|Medellín|Cajicá|Antioqueño|Rappi|Didi|Uber Eats` and classify every match.
- [ ] **Step 2: Verify positive Bahrain markers** `BHD|en-BH|BenefitPay|Talabat|+973|tax_rate: 10` across intended surfaces.
- [ ] **Step 3: Run `npm run validate:migrations`, `npm run lint`, `npm test`, and `npm run build` when an execution runtime is available.**
- [ ] **Step 4: Check GitHub Actions/statuses for the exact head SHA. Do not claim CI passed if no run exists.**
- [ ] **Step 5: Review PR diff for unintended destructive schema changes.**
- [ ] **Step 6: Merge PR #1 to `main` using the exact expected head SHA because the repository owner explicitly approved the hard cutover and requested `main`.**
- [ ] **Step 7: Fetch `main` and verify it points to the merged Bahrain-native ZAIPOS revision.**
