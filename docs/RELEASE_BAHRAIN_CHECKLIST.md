# ZAIPOS Bahrain Release Checklist

Before a release is promoted to `main` or packaged:

1. `node scripts/audit-localization.mjs` passes.
2. `npm run validate:migrations` passes.
3. `npm run lint` passes.
4. `npm run test` passes.
5. `npm run build` passes.
6. Package identity is `zaipos` / `ZAIPOS` in `package.json` and `package-lock.json`.
7. PWA and Electron manifests use ZAIPOS branding.
8. Currency displays BHD with three decimal places.
9. Standard Bahrain VAT default is 10%.
10. Customer and delivery examples use Bahrain +973/address conventions.
11. Payment labels are Cash, Card, BenefitPay, and Bank Transfer.
12. Active marketplace/channel surfaces do not expose Rappi, Didi Food, Uber Eats, COP, Colombia, or `es-CO`.
13. Installer/browser/PWA/social assets use the current ZAIPOS identity.
14. Fresh database seeds are Bahrain-native and do not create hard-coded demo credentials.
15. Any compatibility-only historical values are not presented as active Bahrain behavior.
