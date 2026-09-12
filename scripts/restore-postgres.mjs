import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`ZAIPOS restore failed: ${message}`);
  process.exit(1);
}

function psql(databaseUrl, statement) {
  return execFileSync(
    "psql",
    ["--dbname", databaseUrl, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement],
    {
      env: { ...process.env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

const archiveArg = process.argv[2];
if (!archiveArg) fail("usage: node scripts/restore-postgres.mjs <archive.dump>");

const databaseUrl = process.env.ZAIPOS_DATABASE_URL;
if (!databaseUrl) fail("ZAIPOS_DATABASE_URL is required");

const archivePath = path.resolve(archiveArg);
const checksumPath = `${archivePath}.sha256`;
if (!existsSync(archivePath)) fail(`backup archive not found: ${archivePath}`);
if (!existsSync(checksumPath)) fail(`checksum sidecar not found: ${checksumPath}`);

// Integrity is checked before any target inspection or mutation. This keeps a corrupt
// or tampered archive incapable of reaching pg_restore.
const checksumText = readFileSync(checksumPath, "utf8").trim();
const expected = checksumText.split(/\s+/)[0]?.toLowerCase();
if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
  fail("checksum sidecar is invalid");
}
const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
if (actual !== expected) fail("checksum integrity verification failed");

if (process.env.ZAIPOS_RESTORE_CONFIRM !== "RESTORE_TO_EMPTY_DATABASE") {
  fail("explicit restore confirmation required: set ZAIPOS_RESTORE_CONFIRM=RESTORE_TO_EMPTY_DATABASE");
}

try {
  const tables = psql(
    databaseUrl,
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;",
  )
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (tables.length === 0) {
    fail("target database has no migrated public schema; apply the production migration chain first");
  }

  for (const table of tables) {
    const hasRows = psql(
      databaseUrl,
      `SELECT EXISTS (SELECT 1 FROM public.${quoteIdentifier(table)} LIMIT 1);`,
    );
    if (hasRows === "t") {
      fail(`target database is not empty; refusing restore because public.${table} contains data`);
    }
  }

  execFileSync(
    "pg_restore",
    [
      "--dbname",
      databaseUrl,
      "--data-only",
      "--schema=public",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      archivePath,
    ],
    {
      env: { ...process.env },
      stdio: "inherit",
    },
  );

  console.log(`ZAIPOS restore completed from verified archive: ${archivePath}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
