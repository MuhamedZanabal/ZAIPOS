# ZAIPOS Bahrain Localization Policy

ZAIPOS is Bahrain-native by default and the user-facing interface is English.

## Required invariants

- Product identity: ZAIPOS.
- Locale: `en-BH`.
- Currency: BHD with three decimal places.
- Standard VAT default: 10%, with zero-rated and exempt treatment supported where applicable.
- Bahrain phone conventions: +973 and eight-digit local numbers.
- Primary Bahrain payment labels: Cash, Card, BenefitPay, Bank Transfer.
- Bahrain channels: POS, Tables, Talabat, WhatsApp, In-house Delivery.
- No active Rappi, Didi Food, Uber Eats, COP, Colombia, `es-CO`, or legacy POS S360T product assumptions.
- Historical persisted values may remain only when required for backward compatibility and must not be exposed as active Bahrain product behavior.

## Verification

Run:

```bash
node scripts/audit-localization.mjs
npm run validate:migrations
npm run lint
npm run test
npm run build
```

CI runs the localization audit before the normal quality gates.
