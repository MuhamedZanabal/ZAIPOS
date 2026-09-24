# ZAIPOS external acceptance handoff

This document is for the physical and administrative team. It is not software acceptance and it does not claim production readiness.

Code integration is complete on `main` at `d721daf7b8e3203b98fa085b03763a39f849d864` ([PR #90](https://github.com/MuhamedZanabal/ZAIPOS/pull/90)). That SHA is the merge of reviewed head `8a0a02daa0a03fcdca9b9fb22712854cf12b3e87`. Its Git tree is identical to that head (`ddad4eaf955ef7c09bb178e3cd000c72a7271156`).

Offline checkout stays disabled. `electron/main.ts` constructs the offline orchestrator with `{ enabled: false }`. Do not enable it during installation, hardware, or recovery tests.

Unsigned CI packaging is not a signed release. Repository tests are not physical, regulatory, or disaster-recovery acceptance.

Bahrain timestamp of this handoff: 2026-09-24 12:24 +03.

## What software already proved

On SHA `d721daf7b8e3203b98fa085b03763a39f849d864`, these workflows completed successfully:

| Workflow | Run | Event |
|---|---|---|
| CI, including quality job `107570600291` and unsigned `windows-package` job `107571592078` | [35980388075](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980388075) | push |
| Trusted Device Enforcement | [35980465067](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980465067) | workflow_dispatch |
| Authorization Surface Census | [35980466033](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980466033) | workflow_dispatch |
| Backup Restore Contract | [35980387852](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387852) | push |
| Table Checkout Security | [35980387902](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387902) | push |
| Cash Till Intelligence | [35980387844](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387844) | push |
| Catalogue Import | [35980387907](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387907) | push |
| Customer Credit Subledger | [35980388061](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980388061) | push |
| Customer Loyalty Ledger | [35980387939](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387939) | push |
| Customer Profiles and Addresses | [35980387874](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387874) | push |
| Delivery Financial Authority | [35980387912](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387912) | push |
| Deterministic Reporting | [35980387847](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387847) | push |
| Inventory Lots | [35980387838](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387838) | push |
| Inventory Valuation | [35980387839](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387839) | push |
| Operational Alerts | [35980387850](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387850) | push |
| Operational Alerts V1 | [35980387848](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387848) | push |
| AI Read Controller | [35980388135](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980388135) | push |
| AI Action Approval | [35980387916](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387916) | push |
| Stocktake | [35980388026](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980388026) | push |
| Supplier Product Catalogue | [35980387924](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387924) | push |
| Supplier Subledger | [35980387967](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35980387967) | push |

The Device Credential Heartbeat workflow does not run on `main`. It succeeded on the identical tree as job `contract` `107552849985` in [run 35974864333](https://github.com/MuhamedZanabal/ZAIPOS/actions/runs/35974864333). The Release workflow was not run. It publishes only from a version tag and requires signing secrets.

## 1. Signed Windows installation, upgrade, rollback, and data preservation

Humans must do this. CI `windows-package` is unsigned and is not acceptance.

### Credentials required before any production installer

1. Obtain an Authenticode code-signing certificate whose subject is the legal publisher of ZAIPOS.
2. Store the certificate and its password as protected GitHub Actions secrets:
   - `WINDOWS_CSC_LINK` (electron-builder `CSC_LINK`)
   - `WINDOWS_CSC_KEY_PASSWORD` (electron-builder `CSC_KEY_PASSWORD`)
3. Do not place the certificate or password in the repository, chat, or a terminal log.
4. Confirm `node scripts/require-windows-signing.mjs` fails closed when those variables are absent. That script is the release gate in `npm run release:windows`.

### Build and publish

1. Tag only the accepted `main` SHA, using `vMAJOR.MINOR.PATCH` or `vMAJOR.MINOR.PATCH-beta.N`.
2. Let `.github/workflows/release.yml` run. A tag build must execute `npm run release:windows`, which refuses to continue without the signing secrets.
3. Record the exact tag, commit SHA, workflow run URL, installer file name, file size, and SHA-256.
4. On a clean Windows x64 machine, verify the installer signature in file properties and with `Get-AuthenticodeSignature`. `Status` must be `Valid`. A missing or unknown publisher is a failure.
5. Install per-machine (NSIS is configured `perMachine: true`, `oneClick: true`). Record the installed version from the application.

### Upgrade

1. Install the previous accepted signed build first, then the new signed build through the in-app stable update channel (`download-update` / `install-update`).
2. Prove the version changes and the signature remains valid.
3. Preserve, across the upgrade:
   - tenant login and branch selection
   - OS-protected device credential (`safeStorage`); the terminal must stay provisioned without revealing the credential
   - printer and scanner settings
   - open cash-session identity and till history
   - local recovery journals
4. Do not enable offline checkout to “test sync” during the upgrade.

### Rollback and data preservation

1. Take a verified PostgreSQL backup immediately before the upgrade. See section 3.
2. Roll the desktop client back to the previous signed installer.
3. Prove sales, payments, stock, till movements, customer credit, supplier ledger, and device enrollment created before the upgrade are still readable and unchanged.
4. Do not drop new immutable operation or audit ledgers to force an old client to work. If an old client is denied a revoked legacy API, forward-fix the client or keep the new client. Document any operator action required.
5. Record whether local OS credential storage and Electron settings survived uninstall/reinstall. A full uninstall may destroy local custody; that must be an explicit tested case, not an assumption.

Acceptance is incomplete until a named person signs the installation, upgrade, and rollback records with the SHA-256 of each installer.

## 2. Physical scanner, printer, and cash-drawer acceptance

Repository tests do not open a serial port, print paper, or fire a drawer solenoid. Procure and test the real devices.

### Supported software boundaries

- Barcode scanner: HID keyboard-wedge mode, or serial mode through `serialport` at the configured baud rate (default 9600). Serial mode accepts only an enumerated device path.
- Receipt printer: ESC/POS Epson-compatible over USB device path or TCP `host:port`. Bluetooth is rejected until a reviewed transport exists. Default width is 42 characters, allowed range 16–80.
- Cash drawer: opened by the printer `open-drawer` command. The drawer must be electrically connected to the tested printer. There is no separate cash-drawer driver.

### Target hardware to procure

1. One Windows x64 POS terminal whose operating-system credential encryption is available (Electron `safeStorage`).
2. One HID barcode scanner and one serial barcode scanner, or a written decision to accept only one of those modes.
3. One USB ESC/POS receipt printer and, if network printing will be used in stores, one network ESC/POS printer.
4. One cash drawer that kicks from that printer’s drawer port.
5. Spare paper and a known test barcode that exists in the catalogue.

### Tests a person must execute and record

For each device, record model, connection, Windows port, operator, date, and pass/fail.

1. HID scanner: focus a sale line and scan. The scanned code must match the catalogue item. A scan must not create a sale by itself.
2. Serial scanner: select the enumerated COM port and baud rate. Confirm an unplugged or unknown port fails closed. Scan the same known barcode.
3. USB printer: print a BHD receipt with three decimal places, VAT line, and QR if a QR payload is present. Arabic or mixed text used by the store must be readable. A missing printer must fail closed without recording a second payment.
4. Network printer: repeat the receipt test at the configured host and port. A wrong port must fail without a financial effect.
5. Drawer: issue open-drawer. The drawer must open once. Opening the drawer must not create a cash movement, sale, or audit row.
6. Reprint and a second drawer kick must not duplicate the original sale.
7. Retail tenant: restaurant table, waiter, and kitchen screens stay unavailable, and a direct restaurant route fails closed. Restaurant tenant: those screens remain available. Use one tenant of each mode.

Photograph the receipt and note the sale identifier. Do not treat a screenshot of the CI log as hardware acceptance.

## 3. Production disaster-recovery exercise and measured RPO/RTO

CI backup/restore uses a disposable database. It does not measure production RPO or RTO.

The in-repository command is `node scripts/backup-postgres.mjs <archive.dump>` with `ZAIPOS_DATABASE_URL` set. It writes a custom-format public-data dump, a manifest, and a SHA-256 file, mode `0600`. It refuses to overwrite an existing backup and aborts if the schema changes during the dump. Restore is `scripts/restore-postgres.mjs`.

The backup scope is `public` data only. It does not include:

- Supabase Auth users and sessions
- Storage objects
- platform roles and secrets
- device credentials held only in the terminal OS vault
- unsynchronized local queues or journals

### Exercise the team must run

1. Freeze schema migrations for the window.
2. On the production or production-shaped database, take a backup with the script above. Record start and finish timestamps.
3. Verify the SHA-256 and manifest `gitSha` against the deployed application SHA.
4. Restore into an empty, isolated database. Do not restore over production.
5. Compare row counts and exact fils totals for sales, payments, sale items, cash sessions, cash movements, stock, customer credit, supplier ledger, delivery collections, and audit logs.
6. Confirm a restored financial mutation replays instead of duplicating.
7. Separately export and restore Auth and Storage using the provider’s supported procedure. Record that those boundaries were covered outside the public-data dump.
8. Define the business RPO and RTO targets in writing before the exercise. Measure:
   - RPO: time from the last recoverable backup to the simulated failure
   - RTO: time from the failure decision to a restored database that passes the reconciliation above
9. Write the measured durations, the people involved, and any gap. Do not copy a CI elapsed time into this record.

No production RPO or RTO number exists yet. Leaving this section blank after the exercise is a failed acceptance.

## 4. Bahrain regulatory acceptance

Software defaults are not regulatory approval.

The application defaults new tenants to BHD, `en-BH` formatting, three decimal places, and 10% VAT, and it allows zero-rated and exempt product rates. Receipt templates can show CR, Bahrain address, and VAT details. That configuration does not replace National Bureau for Revenue guidance, a tax opinion, or an e-invoicing mandate.

### What humans must obtain

1. A written determination, from the business’s tax adviser or the NBR, of the VAT treatment the store will use: standard 10%, zero-rated, and exempt items.
2. Confirmation whether simplified tax invoices, full tax invoices, or a future e-invoicing format is required for this business, and whether the current receipt fields satisfy that format.
3. The commercial registration (CR) number and VAT account number that must be printed, and a sample receipt checked against that requirement.
4. A decision on hosting location and whether Supabase project region meets the business’s contractual and regulatory constraints.
5. If card, BenefitPay, or any other payment provider will be used, the provider contract and reconciliation procedure. The repository does not authorize live settlement.
6. A named owner who accepts residual risk for WhatsApp, email, and AI features before those providers are enabled. They remain optional and are not part of this code-complete claim.

Record the adviser, date, and the exact receipt sample. Do not mark this gate complete because the default tax rate is 10.

## 5. Signing credentials and hardware procurement checklist

Buy or issue only the following. No vendor has been selected by the repository.

| Item | Requirement | Done |
|---|---|---|
| Authenticode certificate | Legal publisher, exportable to `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` | |
| GitHub secret storage | Both secrets set on the protected release environment, never committed | |
| Windows x64 terminal | OS credential encryption available; used for install, upgrade, and rollback | |
| HID barcode scanner | Keyboard-wedge acceptance, or a written waiver | |
| Serial barcode scanner | Enumerated COM port, or a written waiver | |
| USB ESC/POS printer | Epson-compatible, drawer kick port | |
| Network ESC/POS printer | Only if stores will print by TCP | |
| Cash drawer | Wired to the accepted printer | |
| Receipt paper and known barcode | Catalogue item with a scannable code | |
| Isolated restore database | Not the production instance | |
| Backup storage | Private directory, `0600` artifacts, off-terminal copy | |
| Tax/regulatory reviewer | Written Bahrain VAT and invoice decision | |

## Explicit non-claims

- Offline checkout is not accepted and must remain disabled.
- No physical scanner, printer, or drawer has been accepted.
- No production RPO or RTO has been measured.
- No NBR or payment-provider approval is claimed.
- No signed installer has been published from this SHA.
- Merging PR #90 does not deploy the application or change production financial data.
