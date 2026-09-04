# ZAIPOS Setup

## Requirements

- Node.js 20+
- npm
- Supabase CLI for local backend development
- Docker only when using the container deployment path

## Clone and Install

```bash
git clone https://github.com/MuhamedZanabal/ZAIPOS.git
cd ZAIPOS
npm ci
```

Copy `.env.example` to the appropriate local environment file and configure the public Supabase URL/key plus any optional integration settings. Never place service-role keys or production secrets in frontend environment variables.

## Bahrain Defaults

A new ZAIPOS environment assumes:

- locale `en-BH`
- currency `BHD`
- three-decimal money formatting
- standard VAT default `10%`
- Bahrain telephone prefix `+973`
- Cash, Card, BenefitPay, and Bank Transfer payment terminology
- Physical POS, Tables, Talabat, WhatsApp, and In-house Delivery channels

The local seed uses Bahrain business names, addresses, phone formats, products, and BHD-scale prices.

## Local Frontend

```bash
npm run dev
```

## Local Supabase

Use the Supabase CLI to start/reset the local project according to your normal development workflow. Migration validation is available with:

```bash
npm run validate:migrations
```

The migration chain includes the Bahrain cutover migrations and must be applied in timestamp order.

## Quality Gates

Before shipping:

```bash
npm run validate:migrations
npm run lint
npm run test
npm run build
```

## Electron

Development:

```bash
npm run dev:electron
```

Package:

```bash
npm run build:electron
```

The packaged application identity is ZAIPOS. Existing local Electron settings intentionally keep compatibility-sensitive storage identifiers where renaming them would discard installed-device configuration.

## Deployment

See `deployments/README.md` and `docs/production-runbook.md`. The maintained example deployment is `deployments/instances/demo-zaipos/`.

## Security

- Do not commit credentials or hard-coded passwords.
- Keep service-role operations server-side.
- Preserve tenant/branch Row Level Security.
- Treat BenefitPay and bank-transfer references as payment evidence, not as proof of settlement unless the application has a verified payment-provider result.
