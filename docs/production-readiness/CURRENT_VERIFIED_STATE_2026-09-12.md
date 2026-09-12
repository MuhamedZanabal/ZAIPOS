# ZAIPOS current verified production state — 2026-09-12

This addendum supersedes only stale **current-state / current-main** assertions in `BURN_DOWN.md`. Historical evidence in that file remains valid unless explicitly superseded here.

## Current verified main

- `main`: `f54d2e73c1a4676dd740b7e7cd4d81863fdd545e`
- Merge: PR #51 — ZAIPOS AI operational-alerts v1 surface
- PR #51 exact tested head: `34943c635512bbe3c173faa3b305317a16712507`
- Exact-head workflow evidence:
  - CI run `34718514806`: successful quality and Windows validation packaging
  - AI Read Controller Contract run `34718514805`: success
  - Operational Alerts Contract run `34718514810`: success
  - AI Action Approval Contract run `34718514811`: success
- Post-merge `main` CI run `34718777647`: quality, full test/build matrix and Windows validation packaging succeeded.

## P1 status

The repository burn-down's implemented P1 slices remain complete through the authoritative transaction, catalogue, inventory, supplier, customer, reporting, backup/restore, delivery and cash/till work already merged to `main`.

Notable later P1 merges preserved by the current regression matrix include:

- PR #38 — verified PostgreSQL backup/restore rehearsal with SHA-256 integrity evidence and exact-fils/inventory round-trip checks.
- PR #44 — authoritative cash/till intelligence sourced from immutable exact-fils close snapshots.

No new unresolved P0/P1 repository defect was identified in the current re-audit.

## P2 control-plane status

The following production slices are merged and regression-preserved:

- PR #39 — source-backed read-only AI reporting controller.
- PR #42 — human-reviewed AI action-request queue with no autonomous execution path.
- PR #45 — branch-scoped user-facing action request/review surface without an execution path.
- PR #46 — deterministic source-backed operational alerts.
- PR #48 — `get_operational_alerts_v1` with explicit 0..365-day expiry/cash windows, deterministic Bahrain-date handling and closed-session exact-fils cash-variance evidence. Exact tested head `aa408315205e03e2da7337a324bf967e31ac601e`; merge `b1e55d00fbef0358c6672a18af1e4372aeb9b8ff`.
- PR #51 — ZAIPOS AI now consumes the richer v1 authority with explicit 30-day expiry and 7-day cash lookback windows and surfaces exact-fils cash-variance evidence without introducing mutation authority or polling.

## Preserved production invariants

- BHD monetary authority remains integer fils at authoritative transaction/accounting boundaries.
- Checkout and sensitive transaction mutations remain server-authoritative and idempotent.
- Offline checkout behavior remains constrained by the verified replay/failure-state model.
- Tenant/branch authorization, audit evidence and exact-money migration contracts remain in the general CI gate.
- Operational AI remains read-only unless a separately authorized human-reviewed mutation path is explicitly invoked; current alert surfaces do not autonomously mutate business state.

## Repository-external / deployment-boundary blockers

These are not fixable by ordinary repository commits in the current connected permission/environment boundary:

1. **Protected `main` / required checks** — the branch is currently unprotected and enforcement requires repository-administration capability not exposed by the connected GitHub App.
2. **Production Authenticode signing** — requires externally supplied signing credentials (`WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`). Unsigned Windows validation packaging is green.
3. **Physical acceptance** — printer, cash drawer and installed-updater behavior require testing on deployed Windows POS hardware.

## Explicitly later / separately scoped capabilities

The existing burn-down intentionally leaves these outside the completed P0/P1/P2 production slices:

- competitor / external price intelligence with authoritative provenance;
- production OCR ingestion beyond current inventory-mutation safety boundaries;
- WhatsApp operational-channel integration;
- optional LAN-resilience expansion, only after a measured decision gate demonstrates need.

These should not be represented as completed without their own RED/GREEN authority, failure, security and production-evidence cycles.
