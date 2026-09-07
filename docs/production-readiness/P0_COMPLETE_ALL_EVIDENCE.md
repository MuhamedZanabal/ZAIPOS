# P0 complete-all production evidence

PR #17 was merged and its exact merge SHA passed `main` CI. External controls remain explicitly blocked until their evidence exists.

## Transaction and migration gates

Final PR head `d1299cef771dd8ad5104f034b20269f89d93cd1f` passed CI run #224 (`34164371309`). Squash merge `6ad10038f5f12471a0ca252c52df3b0dafc1c669` passed post-merge `main` CI run #225 (`34164733691`); both runs completed `quality` and `windows-package` successfully.

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

## Release repository gates

- `electron-builder.config.json` publishes versioned NSIS artifacts and updater metadata to `MuhamedZanabal/ZAIPOS`.
- Stable and beta release tags must be version-matched, annotated, and GitHub signature-verified.
- Production publishing fails closed without `CSC_LINK` and `CSC_KEY_PASSWORD` sourced from protected GitHub secrets.
- Update download and installation each require explicit operator approval.
- The device registry records tenant, branch, stable device ID, version, OS, channel, state, capabilities, and last seen through an authorized RPC; direct mutation is denied.
- CI validates an unsigned Windows installer on `windows-latest`; only the protected release workflow may publish a signed production installer.

Post-merge artifact ID `10033852748` is 112,608,151 bytes with SHA-256 `a015281fea2838882022bd3093e6e741344901487e71c653224145dda265d8be`. It is validation evidence only and is not represented as a signed production release.

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
