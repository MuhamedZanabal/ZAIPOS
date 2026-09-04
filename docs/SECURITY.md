# ZAIPOS Security

ZAIPOS is a multi-tenant transactional system. Security controls must protect tenant isolation, branch scope, payment integrity, credentials, and offline synchronization.

## Tenant Isolation

- Tenant-scoped data uses `tenant_id`.
- Branch-scoped data additionally uses `branch_id`.
- Supabase Row Level Security is the primary database isolation boundary.
- Role helpers must validate authenticated membership and branch scope.
- Service-role access is restricted to server-side functions and operational tooling.

## Credentials

Never commit:

- Supabase service-role keys;
- provider API secrets;
- hard-coded production credentials;
- hard-coded demo passwords;
- customer credentials or payment secrets.

Browser code may only receive credentials intended for public-client use.

## Transaction Integrity

Checkout, returns, inventory mutations, and synchronization require authorization and idempotency. A retry must not duplicate sales, payments, BenefitPay records, or stock effects.

## Bahrain Payment Semantics

BenefitPay is a user-facing payment method mapped to the existing internal QR accounting bucket for compatibility. Selecting BenefitPay in the POS is not equivalent to independently verified settlement unless a trusted provider response exists. Do not fabricate payment confirmation.

Bank Transfer similarly records the selected method/reference state; settlement evidence must come from an authorized source when required.

## External Platforms

Talabat is represented as a Bahrain marketplace channel. ZAIPOS does not expose fabricated partner API actions. Any future direct marketplace integration must use documented partner credentials server-side and validate webhook authenticity.

## AI and WhatsApp

AI tools must respect tenant and branch authorization. Prompts and tool output must not expose another tenant's data or invent transactional state. WhatsApp/provider credentials remain server-side.

## Offline Security

Local IndexedDB state is a continuity mechanism, not an authorization bypass. Replayed operations are revalidated by server-side controls. Sensitive local data should be minimized and cleared appropriately on sign-out.

## Reporting Security Issues

Security vulnerabilities should be disclosed privately to the maintainers. Do not post credentials, exploit details, or customer data in public issues.
