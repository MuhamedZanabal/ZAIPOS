import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`ZAIPOS backup failed: ${message}`);
  process.exit(1);
}

const outputArg = process.argv[2];
if (!outputArg) fail("usage: node scripts/backup-postgres.mjs <archive.dump>");

const databaseUrl = process.env.ZAIPOS_DATABASE_URL;
if (!databaseUrl) fail("ZAIPOS_DATABASE_URL is required");

const archivePath = path.resolve(outputArg);
const checksumPath = `${archivePath}.sha256`;
if (existsSync(archivePath) || existsSync(checksumPath)) {
  fail(`backup archive or checksum already exists; refusing overwrite: ${archivePath}`);
}

// Ensure any files created by pg_dump or this process are owner-only even when the
// caller has a permissive shell umask. Backups contain production business data.
process.umask(0o077);

try {
  execFileSync(
    "pg_dump",
    [
      "--dbname",
      databaseUrl,
      "--format=custom",
      "--data-only",
      "--schema=public",
      "--no-owner",
      "--no-privileges",
      "--file",
      archivePath,
    ],
    {
      env: { ...process.env },
      stdio: "inherit",
    },
  );

  chmodSync(archivePath, 0o600);
  const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  writeFileSync(checksumPath, `${digest}  ${path.basename(archivePath)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(checksumPath, 0o600);

  const source = process.env.ZAIPOS_BACKUP_SOURCE ?? "unspecified";
  console.log(`ZAIPOS backup created: ${archivePath}`);
  console.log(`ZAIPOS backup checksum: ${checksumPath}`);
  console.log(`ZAIPOS backup source: ${source}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
