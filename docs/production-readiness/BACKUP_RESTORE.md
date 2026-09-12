# PostgreSQL disaster recovery

## Authority and scope

ZAIPOS main uses React 18, Electron, Dexie browser persistence and Supabase PostgreSQL. PostgreSQL owns committed business truth. This recovery procedure captures every ordinary/partitioned `public` table using a consistent PostgreSQL custom data archive, including authorization, immutable money and stock records, audit evidence and operation ledgers. It does not recover pending Dexie queues on lost devices.

**External prerequisites:** independently recover Supabase Auth identities with their original UUIDs, provider roles/extensions/functions, Storage metadata and object bytes (including return evidence and product images), secrets and deployment configuration. Restoring public profiles without the referenced Auth users must fail foreign-key validation. Public-schema data is not a complete Supabase project backup.

The archive contains data, not executable schema installation. Apply the matching reviewed migrations to an isolated replacement provider environment first. Restore compares the actual public-schema DDL fingerprint before writing. The manifest's local migration-chain hash identifies the code used to create the backup; it does not independently attest which migrations were applied to the source. The live schema fingerprint is the compatibility check.

Current UUID-based ZAIPOS has no public sequences, foreign tables or materialized views. The scripts reject these object types if introduced: PostgreSQL `setval` is not transactional, and silently accepting it would invalidate atomic rollback guarantees. Such schema additions require a reviewed recovery implementation before deployment.

## Prerequisites and responsibility

- Node.js 24 and matching PostgreSQL 17 client utilities (`psql`, `pg_dump`, `pg_restore`). Use the same client patch release for backup and rehearsal to avoid schema-rendering differences.
- A direct database connection, rather than a transaction pooler. Preserve TLS validation; remote production URLs should use `sslmode=verify-full` with the appropriate root certificate.
- Backup principal: complete read access to public business data, bypassing RLS as authorized, plus schema metadata visibility. A partial RLS-visible dump is not acceptable.
- Recovery principal: reviewed DDL/insert privileges on the isolated target and ability to restore and validate foreign keys/triggers. Ordinary cashier credentials cannot perform recovery.
- Owner-only directory (`0700`) on a filesystem supporting restrictive POSIX permissions, atomic hard links and fsync. Run the operator utilities on a secured Linux recovery host; Windows installer validation does not certify these filesystem guarantees.
- DBA/operator maintains retention, encrypted off-site copies and provider recovery; store owner accepts reconciled balances and operational cutover.
- Freeze migrations during backup and recovery. Keep application traffic and other administrative writers disconnected from the recovery target throughout validation.

Credentials are parsed into libpq environment variables, never PostgreSQL command-line arguments. The tools suppress raw subprocess diagnostics because COPY errors may contain private rows. Protect the recovery host/process environment and database logs. Never include credentials, production rows or archives in CI, chat or issue comments.

## Backup

```bash
install -d -m 700 /secure/backups
# Supply this through your secret manager; do not put a real URL in shell history.
export ZAIPOS_DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=verify-full'
node scripts/backup-postgres.mjs /secure/backups/zaipos-YYYYMMDD-HHMMSS.dump
```

Success publishes three `0600` files:

1. `*.dump`: PostgreSQL custom-format public data.
2. `*.dump.manifest.json`: completion state, timestamps, non-secret source endpoint/server identity, PostgreSQL major, live schema SHA-256, migration-chain hash/count/latest file, application version/Git SHA when available, byte size, artifact SHA-256, permission expectation and excluded boundaries.
3. `*.dump.sha256`: hashes of both archive and manifest; published last as the completion marker.

Existing artifacts are never overwritten. A private per-archive lock prevents competing writers. Ordinary dump/hash/write failures remove artifacts published by that failed attempt. A hard kill/power loss can leave a lock or incomplete set: quarantine it and create a new backup filename. Never fabricate a completion marker. Hashing streams the archive rather than loading it into RAM.

Copy all three files together to encrypted, access-controlled off-site storage. Verify after copying, retain multiple generations, and monitor failed/missed backup runs externally. SHA-256 detects corruption; it does not authenticate a maliciously replaced archive and manifest. Use a trusted, immutable or independently authenticated backup repository. PostgreSQL restore archives must come from trusted operators.

## Verify and restore

On the secure recovery host:

```bash
cd /secure/backups
sha256sum --check zaipos-YYYYMMDD-HHMMSS.dump.sha256
```

1. Record the incident and selected backup timestamp/hash. Preserve the damaged database and unsynchronized device queues for reconciliation.
2. Provision an isolated replacement provider environment; recover Auth/Storage and provider prerequisites independently.
3. Apply the matching reviewed migration chain; ensure all public tables are empty. Remove migration seed data only through the separately reviewed provisioning procedure on that disposable target.
4. Keep applications disconnected. Inspect the manifest and target identity. Allocate free space for the archive copy, expanded SQL and restored database/indexes.
5. Set the acknowledgement and the exact expected endpoint (`hostname:port/percent-encoded-database-name`). The endpoint must match the connection URL and differ from the source.

```bash
export ZAIPOS_DATABASE_URL='postgresql://USER:PASSWORD@RECOVERY_HOST:5432/DATABASE?sslmode=verify-full'
export ZAIPOS_RESTORE_CONFIRM='RESTORE_TO_EMPTY_DATABASE'
export ZAIPOS_RESTORE_TARGET='RECOVERY_HOST:5432/DATABASE'
node scripts/restore-postgres.mjs /secure/backups/zaipos-YYYYMMDD-HHMMSS.dump
```

There is no overwrite, checksum-bypass or schema-bypass option. The script verifies private copies of the archive and manifest before opening a database connection, checks format/size/hash, requires exact target acknowledgement, rejects source identity and mismatched PostgreSQL/schema versions, and generates SQL before starting database mutation.

Restoration takes access-exclusive locks on all public tables and checks emptiness **inside the same transaction**. User triggers are temporarily disabled; public foreign keys are temporarily dropped. All foreign keys are recreated/validated and each user trigger's original enabled/disabled/replica/always state restored before commit. COPY, lock timeout, constraint validation or client failure rolls back transactional data and DDL. A successful restore is not authorization to route traffic.

## Acceptance and rollback

- Compare deterministic row SHA-256 fingerprints for **every** public table, stable IDs, operation IDs, integer-fils values, quantities and immutable ledgers against the selected backup's independent evidence/rehearsal.
- Reconcile payments to sales; supplier/customer ledger balances; loyalty reversals; inventory and lots; retained historical prices/VAT/COGS.
- Confirm Auth login/role/tenant/branch isolation, external evidence objects, receipt reprint and read-only reporting.
- Reconcile pending offline operations before reconnecting terminals to avoid losing unsynchronized sales.
- Record operator, source/target, Git/schema version, hashes, timestamps, duration, validation outcomes and business sign-off.
- Route traffic only after operator and business acceptance. Keep the previous environment isolated through the agreed retention period.

On checksum/format/permission/identity/schema failure, stop and select a trusted compatible artifact or fix target provisioning. On database failure, preserve restricted server diagnostics and verify the target is still empty with unchanged schema. Re-provision if there is uncertainty; never bypass checks. If recovery must be abandoned, retain the old database and replacement in isolation and return to the incident procedure. Do not switch traffic back to a known corrupted database automatically.

## Rehearsal and failure evidence

`Backup Restore Contract` provisions **two separate Supabase PostgreSQL instances**, runs fresh and upgrade migration chains on each, creates actual source sales/payments and supplier/customer/loyalty/return/void evidence, independently provisions synthetic target Auth identities, and clears only the disposable target. The source remains intact.

The contract hashes all public tables and requires named critical tables to exist. It checks exact fils/quantity, nonempty ledger fixtures, full fidelity, unchanged source, unchanged schema/trigger configuration, repeat restore, nonempty/source/wrong-target/confirmation/schema rejection, corrupt archive rejection, and rollback on missing provider Auth references. Process-boundary tests separately cover credential redaction, missing tools, permissions and pre-mutation integrity rejection; these are not substitutes for PostgreSQL round-trip evidence.

The rehearsal refuses to run without `ZAIPOS_RECOVERY_REHEARSAL=DISPOSABLE_TEST_DATABASES`, two distinct local endpoints and `POSTGRES_RESTORE_TEST_URL`. Never run the migration fixture scripts against production.

## Recovery objectives

RPO and RTO are **unmeasured business targets**, not verified production performance. Define them with the store owner, automate backups to meet the approved RPO, and time representative full recoveries to establish RTO. Recommended operational cadence: monitor each backup and off-site copy, rehearse after schema/recovery changes and at least monthly. Record database size, hardware, tool versions, restore duration and acceptance duration. CI's small synthetic dataset does not establish production RTO.
