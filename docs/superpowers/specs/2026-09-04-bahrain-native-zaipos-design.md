# ZAIPOS Bahrain-Native Conversion Design

## Goal

Convert ZAIPOS from its inherited Colombia/Latin-America operating assumptions into a Bahrain-native POS product while preserving the existing English UI migration and completing the ZAIPOS rebrand.

## Product baseline

ZAIPOS is Bahrain-first, not multi-country. User-facing defaults and demo content must assume the Kingdom of Bahrain unless tenant data explicitly overrides a business-specific value.

- Product name: `ZAIPOS`
- UI language: English
- Locale: `en-BH`
- Currency: `BHD`
- Currency precision: 3 decimal places
- Standard VAT: 10%
- Additional VAT treatments: zero-rated and exempt remain representable; the app must not imply that every Bahrain supply is always 10%.
- Telephone country code: `+973`
- Normal Bahrain subscriber number length: 8 digits
- Primary local digital payment rail: BenefitPay
- Delivery ecosystem: Talabat, WhatsApp, and in-house delivery

## Hard-cutover rule

Remove Colombia/Latin-America-specific product defaults and runtime surfaces rather than merely relabeling them. This includes COP defaults, 19% VAT defaults, Rappi, Didi Food, Uber Eats-specific ZAIPOS runtime integration surfaces, Colombian demo locations/products, and Colombia-oriented seed tenants.

Where historical database enum values cannot be safely deleted in-place, keep compatibility only at the database storage boundary and stop exposing those values to the Bahrain-native UI. New runtime behavior must not create new Rappi/Didi/Uber data.

## Money and tax architecture

Create a single Bahrain configuration module for locale, currency, VAT defaults, phone rules, and BHD cash shortcuts. Currency rendering must use `Intl.NumberFormat("en-BH", { style: "currency", currency: "BHD", minimumFractionDigits: 3, maximumFractionDigits: 3 })` unless a tenant explicitly supplies another currency.

Do not round BHD transaction values to whole units. Discounts, tips, tendered cash, totals, change, and CSV/report values must retain 3-decimal precision.

Default VAT changes from 19% to 10%. Demo products and newly initialized Bahrain tenants use 10% unless a product is intentionally modeled as zero-rated. Existing tenant-specific tax values are not silently rewritten by client-side code.

## Payments

Replace generic Colombia-oriented payment presentation with Bahrain-native options:

- Cash
- Card
- BenefitPay
- Bank Transfer

BenefitPay is represented as a first-class payment method. Do not invent a BenefitPay merchant API integration. The initial implementation records the payment method and supports merchant-side QR/payment confirmation workflows already possible in the POS without claiming external settlement verification.

BHD cash shortcuts use realistic Bahrain denominations rather than COP-scale values.

## Sales and delivery channels

Expose Bahrain-relevant channels:

- In-person POS
- Tables / Orders
- Talabat
- WhatsApp
- In-house Delivery

Remove Rappi, Didi Food, and Uber Eats from user-facing settings and channel selection. Remove Rappi-specific settings UI and edge functions from the Bahrain product branch. If the existing PostgreSQL enum is difficult to shrink safely, add `talabat` while retaining deprecated enum values as non-exposed compatibility values.

No undocumented Talabat partner API behavior will be fabricated. ZAIPOS will provide the channel/domain model and Bahrain-facing UI; external API calls require documented credentials/contracts.

## Demo and seed data

Replace Colombia-oriented demos with Bahrain-oriented retail/restaurant examples priced in BHD. Remove alcohol-centric and Colombian brand/location fixtures from the default demos. Use realistic Bahrain categories and generic/local products suitable for supermarkets, cafeterias, bakeries, and restaurants.

Seed/default location examples should use Bahrain locations such as Manama, Muharraq, Amwaj Islands, Riffa, Hidd, Seef, Juffair, Saar, and Isa Town.

Default business phone examples use `+973` and 8-digit subscriber numbers.

## AI, WhatsApp, receipts, reports, and exports

System prompts, sample phone numbers, report labels, receipts, exported data, onboarding copy, and WhatsApp examples must not assume Colombia, COP, Spanish-language geography, or LatAm delivery services.

AI parsing may understand Spanish as natural-language input if that is generic language support, but country-specific Colombia/LatAm operating assumptions must be removed.

## Branding

Every product-facing reference uses `ZAIPOS`. Packaging metadata, installer identity, browser/PWA metadata, deployment names, README/docs, lockfiles, icon sources, and runtime UI must not expose POS S360T / POS360T / poss360t branding.

Compatibility identifiers may remain only when changing them would break installed application identity, stored data, or migrations, and every such exception must be documented. The chosen Electron app id is `com.zaipos.pos`.

## Verification

Before merging to `main`:

1. Search all UTF-8 source/config/docs for legacy ZAIPOS brand strings: `S360T`, `POS360T`, `POS S360T`, `poss360t`.
2. Search for country-specific LatAm defaults: `COP`, `19`, `es-CO`, `Colombia`, `Medellín`, `Cajicá`, `Antioqueño`, `Rappi`, `Didi`, `Uber Eats` and classify every remaining match.
3. Verify Bahrain constants: `BHD`, `en-BH`, 3-decimal formatting, 10% VAT, `+973`, BenefitPay, Talabat.
4. Run migration validator, lint, tests, and production build when an execution environment is available.
5. If GitHub Actions still produces no runs, do not claim CI passed; merge only because the repository owner explicitly instructed the Bahrain conversion to be pushed to `main`.
