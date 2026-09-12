# ZAIPOS PostgreSQL Backup and Restore

This runbook defines the production-safe recovery path for ZAIPOS business data.

## Scope

The runtime backs up PostgreSQL `public`-schema **data** in custom `pg_dump` format. Database structure remains owned by the reviewed ZAIPOS migration chain. A restore therefore targets an empty database that has already been migrated to the exact application schema required by the backup.

The backup includes authoritative business records such as tenants, branches, products, exact-fils price/cost history, inventory, sales, payments, checkout operation ledgers, returns, voids, audit evidence, supplier accounting, customer credit and loyalty data where those tables exist in the deployed schema.

Authentication-provider infrastructure and secrets are outside this business-data archive and require the platform provider's independent recovery controls.

## Required tools

- Node.js supported by the repository CI/runtime.
- PostgreSQL client utilities compatible with the production PostgreSQL major version: `psql`, `pg_dump`, and `pg_restore`.
- A database credential with the minimum privileges necessary to read the production `public` schema for backup, or populate an isolated migrated recovery database for restore.

Never commit database URLs, passwords, archive files, or checksum sidecars to the repository.

## Create a backup

Set the database URL in the environment rather than command-line arguments so credentials are not deliberately embedded in the process argument list.

```bash
export ZAIPOS_DATABASE_URL='postgresql://...'
export ZAIPOS_BACKUP_SOURCE='production-primary'
node scripts/backup-postgres.mjs /secure/backups/zaipos-YYYYMMDD-HHMMSS.dump
```

The command:

1. refuses to overwrite an existing archive or checksum sidecar;
2. creates a custom-format, data-only `public` schema archive;
3. forces the archive to owner-only permissions (`0600`);
4. writes an SHA-256 sidecar beside the archive;
5. fails non-zero if `pg_dump` or file creation fails.

Store the `.dump` and `.dump.sha256` together in access-controlled, encrypted backup storage. Copy them to a separate failure domain from the production database. Protect retention/storage policy outside the application repository.

## Verify and rehearse restore

A production backup is not considered recoverable merely because `pg_dump` exited successfully. Regularly rehearse restoration into an **isolated**, non-production database created for recovery verification.

1. Provision an isolated PostgreSQL database.
2. Check out the ZAIPOS release/schema version associated with the backup.
3. Apply the full production migration chain to the isolated database.
4. Confirm all `public` tables are empty before restoration.
5. Set the target database URL and explicit destructive-operation acknowledgement.
6. Run restore.

```bash
export ZAIPOS_DATABASE_URL='postgresql://.../isolated_restore'
export ZAIPOS_RESTORE_CONFIRM='RESTORE_TO_EMPTY_DATABASE'
node scripts/restore-postgres.mjs /secure/backups/zaipos-YYYYMMDD-HHMMSS.dump
```

The restore runtime verifies SHA-256 integrity **before** target mutation, rejects a missing/invalid checksum, requires the exact confirmation token, refuses a target containing public-schema rows, and invokes `pg_restore` with exit-on-error behavior.

After restore, verify at minimum:

- tenant and branch identity;
- authoritative transaction and audit ledgers;
- product/barcode identity;
- exact-fils selling prices, costs, payments, supplier balances, customer credit and loyalty balances;
- inventory quantities and movement history;
- row counts/fingerprints for critical tables;
- application read-only smoke paths against the restored database.

The repository contract `scripts/test-backup-restore-contract.mjs` performs an automated round-trip rehearsal and checks exact-fils values, inventory quantity, critical-table fingerprints, overwrite refusal, archive permissions, checksum creation, and tamper rejection.

## Production restore procedure

Do not restore directly over a live production database.

1. Declare the incident and stop application writes to the affected production database.
2. Preserve the damaged database and logs for forensic/reconciliation purposes when storage permits.
3. Select the intended backup and verify its SHA-256 sidecar independently.
4. Provision a fresh replacement database.
5. Deploy/apply the matching reviewed ZAIPOS migration chain.
6. Confirm the replacement `public` schema contains no business rows.
7. Restore with the explicit confirmation token.
8. Run reconciliation and smoke tests before routing production traffic to the replacement database.
9. Record backup timestamp/source, archive hash, restore operator, target database identity, verification results, and incident/change reference in the operational change record.
10. Keep the previous database isolated until recovery acceptance and retention policy permit disposal.

## Failure handling

- **Checksum mismatch / integrity failure:** quarantine the archive; do not bypass the check. Use another verified backup or investigate storage corruption.
- **Target is not empty:** stop. Provision a fresh recovery target or explicitly clear it through the controlled incident procedure. The restore script deliberately has no force-overwrite path.
- **Migration/schema mismatch:** use the release/migration version matching the backup and rehearse again. Do not edit historical migrations to make an old archive fit.
- **`pg_restore` failure:** preserve command output and target database for diagnosis. Discard/re-provision the failed target before the next attempt.
- **Missing authentication/provider data:** recover that layer through the provider's independent backup/recovery mechanism before reopening user access.

## Recovery objectives and retention

Define RPO/RTO and retention according to business requirements and available storage. At minimum, production operations should maintain multiple generations and at least one copy outside the primary database failure domain. Recovery objectives are operational commitments and must be measured by timed restore rehearsals; repository code alone cannot prove them.

## Security boundaries

Backups contain sensitive business and financial records. Apply least privilege, encryption at rest/in transit, access logging, controlled retention, and secure deletion. Do not transmit archives through chat, issue comments, CI logs, or public artifacts. The repository CI uses only deterministic test data.
