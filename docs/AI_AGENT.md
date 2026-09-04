# ZAIPOS AI Agent

The ZAIPOS AI layer assists staff and customers with catalogue, order, and operational workflows while respecting tenant/branch permissions.

## Bahrain Context

AI prompts and examples must assume:

- Kingdom of Bahrain as the operating market;
- English as the default user-facing language;
- BHD monetary values with three decimal places;
- Bahrain +973 phone conventions;
- standard Bahrain VAT default of 10% while respecting product-specific tax configuration;
- Cash, Card, BenefitPay, and Bank Transfer terminology;
- Talabat, WhatsApp, Physical POS, Tables, and In-house Delivery as active sales-channel concepts.

The agent must not introduce non-Bahrain assumptions, foreign addresses, or removed marketplace integrations.

## Capabilities

Depending on the configured tools and permissions, the agent can:

- search the active catalogue and branch availability;
- quote products using ZAIPOS prices;
- answer knowledge-base questions;
- prepare or assist with order drafts;
- summarize operational data exposed to its role;
- hand off conversations to staff when required.

## Guardrails

- Never fabricate stock, prices, payment confirmation, customer data, tax treatment, or delivery status.
- Use current tenant/branch data as the source of truth.
- Do not expose another tenant's data.
- Do not claim a BenefitPay transaction settled unless the system has verified settlement evidence.
- Do not invent Talabat partner API actions or credentials.
- Sensitive mutations must use approved server-side tools and authorization checks.

## WhatsApp

WhatsApp configuration is branch-aware. Bahrain phone numbers should be normalized consistently when the application expects E.164-style storage. The agent should keep customer-facing text concise and appropriate for the merchant's configured business context.

## Knowledge Base

Knowledge documents are tenant/branch scoped. Retrieved content can supplement catalogue and policy answers but must not override transactional source-of-truth data.

## Model Configuration

Model, temperature, system prompt, and channel behavior are configured per the supported settings surfaces. Secrets for model providers belong server-side.

## Testing

AI changes should verify:

- tenant/branch isolation;
- correct BHD formatting;
- Bahrain payment/channel terminology;
- no fabricated transaction state;
- appropriate handoff on unsupported or ambiguous actions.
