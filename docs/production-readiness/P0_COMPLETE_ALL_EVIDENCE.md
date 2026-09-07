# P0 complete-all candidate evidence

This document records the verified PR candidate state. Repository-verifiable items become complete only after PR #17 is merged and the exact merge SHA passes `main` CI. External controls remain explicitly blocked until their evidence exists.

## Transaction and migration gates

CI run #219 (`34140201475`) passed on exact PR head `0c7263479621b443b93ebf78e65e4e45315b8d73` before this documentation update. The final documentation head must repeat all gates.

The executable contract covers:

- a 59-migration clean install and supported Bahrain upgrade path;
- preservation of product price `1.250 BHD → 1250 fils`, product cost `0.750 → 750 fils`, sale and payment `2.500 → 2500 fils`, opening cash `10.000 → 10000 fils`, till cash `2.500 → 2500 fils`, and inventory quantity `7.500` unchanged;
- composite tenant/branch integrity across every public table carrying both keys, while nullable tenant-wide roles remain valid;
- two simultaneous last-unit checkouts yielding one commit and one insufficient-stock failure;
- two simultaneous calls with one operation ID converging on one sale/payment/stock/till/audit effect;
- manager/cashier/inventory/cross-tenant/wrong-branch authorization;
- direct mutation lockdown and exactly-once audit evidence;
- scan → cart → `checkout_sale_v2` → receipt → printer/drawer → cart clear → stock refresh;
- post-commit printer and drawer failure without checkout retry or financial duplication.

## Release candidate gates

- `electron-builder.config.json` publishes versioned NSIS artifacts and updater metadata to `MuhamedZanabal/ZAIPOS`.
- Stable and beta release tags must be version-matched, annotated, and GitHub signature-verified.
- Production publishing fails closed without `CSC_LINK` and `CSC_KEY_PASSWORD` sourced from protected GitHub secrets.
- Update download and installation each require explicit operator approval.
- The device registry records tenant, branch, stable device ID, version, OS, channel, state, capabilities, and last seen through an authorized RPC; direct mutation is denied.
- CI validates an unsigned Windows installer on `windows-latest`; only the protected release workflow may publish a signed production installer.

External signing evidence is still required for the first production artifact. Required secrets are documented in `RELEASE_OPERATIONS.md`.

## AI safety gates

- hard-coded operational metrics, fake retrieval delays, unsupported source claims, and fake recent actions are removed;
- the browser discloses that no query ran and distinguishes Fact, Inference, and Recommendation;
- the legacy autonomous order agent is fail-closed in P0 read-only mode;
- anonymous, authenticated, and service roles cannot execute legacy AI catalogue, quote, create-order, or handoff RPCs;
- embedding generation now requires an authenticated owner/admin/manager branch role on the server.

## External blockers

- **EXTERNAL ADMIN PERMISSION BLOCKER:** GitHub App branch administration is unavailable; required `main` ruleset is specified in `BRANCH_PROTECTION.md`.
- **EXTERNAL SIGNING-CREDENTIAL BLOCKER:** no trusted Windows certificate secrets are available in this execution context; unsigned production publication is prohibited by code and workflow.
- Physical printer, drawer, and installed-device updater behavior remain hardware acceptance checks; simulated failure invariants are automated in CI.
