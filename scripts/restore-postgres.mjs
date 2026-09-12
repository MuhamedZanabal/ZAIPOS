import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
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

function parseJsonQuery(databaseUrl, statement) {
  const value = psql(databaseUrl, statement);
  return JSON.parse(value || "[]");
}

async function writeChunk(stream, chunk) {
  if (stream.write(chunk)) return;
  await once(stream, "drain");
}

async function restoreAtomically(databaseUrl, archivePath) {
  const tables = parseJsonQuery(
    databaseUrl,
    `
      SELECT COALESCE(
        json_agg(
          json_build_object('schema', n.nspname, 'table', c.relname)
          ORDER BY n.nspname, c.relname
        ),
        '[]'::json
      )::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p');
    `,
  );

  const foreignKeys = parseJsonQuery(
    databaseUrl,
    `
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'schema', n.nspname,
            'table', c.relname,
            'constraint', con.conname,
            'definition', pg_get_constraintdef(con.oid, true)
          )
          ORDER BY n.nspname, c.relname, con.conname
        ),
        '[]'::json
      )::text
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE con.contype = 'f'
        AND n.nspname = 'public';
    `,
  );

  if (tables.length === 0) {
    throw new Error("target database has no migrated public schema; apply the production migration chain first");
  }

  for (const table of tables) {
    const qualified = `public.${quoteIdentifier(table.table)}`;
    const hasRows = psql(databaseUrl, `SELECT EXISTS (SELECT 1 FROM ${qualified} LIMIT 1);`);
    if (hasRows === "t") {
      throw new Error(`target database is not empty; refusing restore because ${qualified} contains data`);
    }
  }

  // A verified disaster-recovery archive must be restored as authoritative historical
  // state. Running normal application triggers while replaying rows is incorrect: for
  // example, inserting products can create fresh product_prices rows before the archived
  // product_prices ledger is copied. Circular foreign keys can likewise make a valid
  // data-only archive impossible to replay in ordinary dependency order.
  //
  // Keep the whole operation in ONE database transaction. User/application triggers and
  // public foreign keys are removed only inside that transaction; exact definitions are
  // recreated and validated before COMMIT. Any COPY, constraint, or trigger-DDL failure
  // aborts the transaction, leaving the migrated empty target unchanged.
  const disableTriggers = tables
    .map(({ table }) => `ALTER TABLE public.${quoteIdentifier(table)} DISABLE TRIGGER USER;`)
    .join("\n");
  const enableTriggers = [...tables]
    .reverse()
    .map(({ table }) => `ALTER TABLE public.${quoteIdentifier(table)} ENABLE TRIGGER USER;`)
    .join("\n");
  const dropForeignKeys = foreignKeys
    .map(
      ({ schema, table, constraint }) =>
        `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} DROP CONSTRAINT ${quoteIdentifier(constraint)};`,
    )
    .join("\n");
  const addForeignKeys = foreignKeys
    .map(
      ({ schema, table, constraint, definition }) =>
        `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} ADD CONSTRAINT ${quoteIdentifier(constraint)} ${definition};`,
    )
    .join("\n");

  const sqlClient = spawn(
    "psql",
    ["--dbname", databaseUrl, "-X", "-v", "ON_ERROR_STOP=1"],
    {
      env: { ...process.env },
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  let sqlClientError = null;
  sqlClient.on("error", (error) => {
    sqlClientError = error;
  });

  await writeChunk(
    sqlClient.stdin,
    `BEGIN;\n${disableTriggers}\n${dropForeignKeys}\n`,
  );

  const archiveReader = spawn(
    "pg_restore",
    [
      "--file=-",
      "--data-only",
      "--schema=public",
      "--no-owner",
      "--no-privileges",
      archivePath,
    ],
    {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let archiveReaderError = null;
  archiveReader.on("error", (error) => {
    archiveReaderError = error;
  });

  try {
    for await (const chunk of archiveReader.stdout) {
      await writeChunk(sqlClient.stdin, chunk);
    }
    const [archiveStatus] = await once(archiveReader, "close");
    if (archiveReaderError) throw archiveReaderError;
    if (archiveStatus !== 0) {
      throw new Error(`pg_restore SQL generation exited with status ${archiveStatus}`);
    }

    await writeChunk(sqlClient.stdin, `\n${addForeignKeys}\n${enableTriggers}\nCOMMIT;\n`);
    sqlClient.stdin.end();

    const [sqlStatus] = await once(sqlClient, "close");
    if (sqlClientError) throw sqlClientError;
    if (sqlStatus !== 0) {
      throw new Error(`atomic restore transaction exited with status ${sqlStatus}`);
    }
  } catch (error) {
    if (!sqlClient.stdin.destroyed) sqlClient.stdin.end();
    if (sqlClient.exitCode === null) await once(sqlClient, "close").catch(() => {});
    throw error;
  }
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
  await restoreAtomically(databaseUrl, archivePath);
  console.log(`ZAIPOS restore completed from verified archive: ${archivePath}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
