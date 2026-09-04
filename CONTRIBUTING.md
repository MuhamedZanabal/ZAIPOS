# Contributing to ZAIPOS

ZAIPOS is an English-language, Bahrain-native point-of-sale platform released under the MIT License.

## Development Baseline

All new application behavior must preserve these project-wide defaults unless a feature explicitly requires otherwise:

- Product name: **ZAIPOS**
- Primary market: **Kingdom of Bahrain**
- User-facing language: **English**
- Locale: `en-BH`
- Currency: `BHD` with three decimal places
- Standard VAT default: `10%`, while supporting valid zero-rated and exempt treatment
- Bahrain telephone convention: `+973`
- Local payment terminology: Cash, Card, BenefitPay, Bank Transfer
- Bahrain channel terminology: Physical POS, Tables, Talabat, WhatsApp, In-house Delivery

Do not introduce legacy POS S360T/POS360T/poss360t branding, Colombian/COP defaults, Latin-American demo data, or active Rappi/Didi/Uber integration code.

## How to Contribute

1. Fork the repository.
2. Clone your fork locally.
3. Create a focused branch such as `feat/short-description` or `fix/short-description`.
4. Make the change with tests where applicable.
5. Run:
   ```bash
   npm run validate:migrations
   npm run lint
   npm run test
   npm run build
   ```
6. Commit with a clear Conventional Commit message.
7. Push the branch and open a pull request.

## Code Style

- TypeScript strict mode is enabled.
- Prefer functional React components and hooks.
- Keep reusable UI in `src/components/ui/` or `src/components/shared/`.
- Keep feature behavior in `src/modules/<feature>/`.
- Use Zustand for global client state and TanStack Query for server state.
- Every Supabase query and mutation must respect tenant and branch isolation.
- Monetary UI must use the shared formatting utilities instead of hard-coded currency symbols or decimal precision.
- Bahrain-specific defaults belong in the shared Bahrain configuration layer rather than duplicated literals.

## Security

Do not commit production credentials, API keys, access tokens, hard-coded demo passwords, or customer secrets. Security issues should be reported privately to the maintainers rather than through a public issue.
