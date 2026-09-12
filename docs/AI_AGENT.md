# ZAIPOS AI Agent

ZAIPOS AI is a source-backed operational intelligence layer for Bahrain retail. Production AI must derive claims from server-authorized ZAIPOS data and must never receive direct authority over transactional truth.

## Bahrain Context

AI prompts and outputs must assume:

- Kingdom of Bahrain as the operating market;
- English as the default user-facing language;
- BHD monetary values with three decimal places;
- authoritative money represented as integer fils inside production data boundaries;
- Bahrain +973 phone conventions;
- standard Bahrain VAT default of 10% while respecting product-specific tax configuration;
- Cash, Card, BenefitPay, and Bank Transfer terminology;
- Talabat, WhatsApp, Physical POS, Tables, and In-house Delivery as active sales-channel concepts.

The agent must not introduce non-Bahrain assumptions, foreign addresses, fabricated marketplace integrations, or unsupported payment state.

## Current Production Capability

P2 begins with a read-only, source-backed controller:

`public.ai_read_reporting_context_v1(branch_id, start_at, end_at, question)`

The controller:

1. requires an authenticated ZAIPOS user;
2. delegates branch authorization and financial aggregation to the verified `get_branch_reporting_snapshot_v1` reporting boundary;
3. returns exact integer-fils reporting facts rather than allowing the AI layer to calculate financial truth from raw client data;
4. returns explicit tenant, branch, time-range, generation-time, source-type, and persisted source-ID evidence;
5. exposes no arbitrary SQL surface;
6. exposes no business-state mutation command.

The ZAIPOS AI workspace may display these facts and evidence. When the source query fails, it must fail closed and show no fabricated fallback metrics.

## Authority Boundary

AI is not authoritative for:

- sale creation or completion;
- payment or BenefitPay settlement;
- inventory movement or stock adjustment;
- prices, discounts, overrides, tax, refunds, returns, or voids;
- supplier or customer balances;
- cash sessions;
- employee permissions or authentication;
- order creation or fulfilment state.

Those operations remain owned by ZAIPOS server commands and their existing authorization, idempotency, exact-money, audit, and tenant/branch invariants.

Legacy AI RPCs capable of catalogue/order workflows remain revoked from `anon`, `authenticated`, and `service_role` while the secured action-control plane is incomplete:

- `ai_search_catalog`
- `ai_quote_order`
- `ai_create_digital_order`
- `ai_handoff_to_human`

The legacy `ai-order-agent` edge function remains fail closed and does not expose autonomous write tools.

## Evidence Contract

Every operational AI claim must be traceable to a source-backed controller response. Evidence should include, as applicable:

- `tenant_id`;
- `branch_id`;
- requested reporting time range;
- generation timestamp;
- source/controller type;
- persisted source IDs or report references;
- authoritative currency and unit metadata;
- explicit limitations when the available source does not support the requested conclusion.

A confidence score is not evidence. Missing or stale evidence must be disclosed rather than replaced with generated estimates.

## Read Controller Design Rules

- AI never executes arbitrary SQL.
- Tenant/branch scope is enforced server-side, never inferred from hidden frontend controls.
- Aggregate before returning operational data to the AI surface.
- Financial values originate from exact-fils authorities and deterministic server calculations.
- Prefer small, purpose-specific read controllers over a generic database query tool.
- Offline mode must deny unsupported live claims rather than replay stale business facts as current truth.

High-value read controllers may progressively cover sales trends, inventory/expiry/reorder conditions, supplier/customer balances, cash reconciliation, report explanation, and variance analysis. Each controller requires its own authorization/evidence contract before exposure.

## Future Model Layer

A language-model provider may be placed above the verified read controllers only after provider secrets and execution are server-side. The model may classify questions and explain evidence, but it must not become the source of financial arithmetic or transactional truth.

Provider/model/version metadata must be recorded for model-generated answers once that layer is enabled.

## Future Action Control Plane

AI-originated writes remain out of scope for the current read-only slice. Any later write capability must use:

`pending action -> policy validation -> human approval -> authoritative server command -> audit event`

There must be no silent AI writes.

## Knowledge Base

Knowledge documents are tenant/branch scoped. Retrieved content can supplement catalogue and policy explanations but must not override transactional source-of-truth data.

## Testing

AI changes must verify:

- tenant/branch isolation;
- exact BHD/fils semantics;
- Bahrain payment/channel terminology;
- source/evidence metadata;
- fail-closed behavior when evidence is unavailable;
- no fabricated transaction state;
- no arbitrary SQL capability;
- no regression of legacy AI RPC lockdown;
- no autonomous business-state mutation capability;
- complete production migration-chain compatibility;
- web build and Windows packaging compatibility before merge.
