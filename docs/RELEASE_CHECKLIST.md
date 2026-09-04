# ZAIPOS Bahrain release checklist

Before release or merge to `main`:

1. `npm ci`
2. `npm run audit:localization`
3. `npm run verify:release`
4. `npm run validate:migrations`
5. `npm run lint`
6. `npm run test`
7. `npm run build`
8. Confirm package/install/PWA/social assets use ZAIPOS branding.
9. Confirm active UI and runtime contain no legacy foreign-market integrations.
10. Confirm `main` can be advanced by fast-forward from the verified release head.
