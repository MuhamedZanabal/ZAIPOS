import { closeSync, copyFileSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSupportedSchema, command, connection, databaseIdentity, fileDigest, ident, jsonQuery, literal, privateDirectory, privateFile, schemaDigest } from "./postgres-recovery.mjs";

async function main() {
  if (!process.argv[2]) throw new Error("usage: node scripts/restore-postgres.mjs <archive.dump>");
  if (!process.env.ZAIPOS_DATABASE_URL) throw new Error("ZAIPOS_DATABASE_URL is required");
  process.umask(0o077);
  const archive = path.resolve(process.argv[2]);
  privateDirectory(path.dirname(archive));
  const work = mkdtempSync(path.join(os.tmpdir(), "zaipos-restore-"));
  try {
    // Verify private copies so later changes to input paths cannot swap the
    // archive that pg_restore actually reads.
    for (const [input, output] of [[archive, "archive.dump"], [`${archive}.manifest.json`, "manifest.json"], [`${archive}.sha256`, "sha256"]]) {
      privateFile(input);
      copyFileSync(input, path.join(work, output));
    }
    const staged = path.join(work, "archive.dump");
    const metadata = path.join(work, "manifest.json");
    const lines = readFileSync(path.join(work, "sha256"), "utf8").trim().split(/\r?\n/);
    const names = [path.basename(archive), `${path.basename(archive)}.manifest.json`];
    if (lines.length !== 2) throw new Error("checksum evidence is invalid");
    for (const [i, file] of [staged, metadata].entries()) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(lines[i]);
      if (!match || match[2] !== names[i] || match[1] !== await fileDigest(file)) throw new Error("checksum integrity verification failed");
    }
    const manifest = JSON.parse(readFileSync(metadata, "utf8"));
    const stat = privateFile(staged);
    if (manifest.formatVersion !== 1 || manifest.status !== "complete" || manifest.scope !== "public-data" ||
      manifest.artifact?.format !== "postgres-custom" || manifest.artifact?.name !== names[0] ||
      manifest.artifact?.bytes !== stat.size || manifest.artifact?.sha256 !== await fileDigest(staged) ||
      !/^[a-f0-9]{64}$/.test(manifest.schemaSha256)) throw new Error("invalid recovery manifest");
    const fd = openSync(staged, "r");
    const magic = Buffer.alloc(5); try { readSync(fd, magic, 0, 5, 0); } finally { closeSync(fd); }
    if (magic.toString() !== "PGDMP") throw new Error("expected PostgreSQL custom archive format");
    if (process.env.ZAIPOS_RESTORE_CONFIRM !== "RESTORE_TO_EMPTY_DATABASE") throw new Error("explicit restore confirmation required");
    const conn = connection(process.env.ZAIPOS_DATABASE_URL);
    if (process.env.ZAIPOS_RESTORE_TARGET !== conn.endpoint) throw new Error("explicit restore target identity does not match connection endpoint");
    const target = databaseIdentity(conn);
    if (target.endpoint === manifest.source?.endpoint ||
      (target.serverAddress && target.serverAddress === manifest.source?.serverAddress && target.serverPort === manifest.source?.serverPort && target.database === manifest.source?.database)) {
      throw new Error("restore target is the source database; refusing overwrite");
    }
    if (target.postgresMajor !== manifest.source?.postgresMajor) throw new Error("incompatible PostgreSQL major version");
    assertSupportedSchema(conn);
    if (schemaDigest(conn) !== manifest.schemaSha256) throw new Error("schema mismatch: apply the matching reviewed migration chain and provider prerequisites");
    const tables = jsonQuery(conn, `SELECT COALESCE(json_agg(c.relname ORDER BY c.relname), '[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p');`);
    if (!tables.length) throw new Error("target has no migrated public schema");
    const fks = jsonQuery(conn, `SELECT COALESCE(json_agg(json_build_object('table',c.relname,'name',con.conname,'definition',pg_get_constraintdef(con.oid,false)) ORDER BY c.relname,con.conname),'[]') FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE con.contype='f' AND n.nspname='public';`);
    const triggers = jsonQuery(conn, `SELECT COALESCE(json_agg(json_build_object('table',c.relname,'name',t.tgname,'enabled',t.tgenabled) ORDER BY c.relname,t.tgname),'[]') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal;`);
    const sql = path.join(work, "data.sql");
    const sqlFd = openSync(sql, "wx", 0o600);
    try { command("pg_restore", ["--file=-", "--data-only", "--schema=public", "--no-owner", "--no-privileges", staged], conn.env, sqlFd); } finally { closeSync(sqlFd); }
    const qualified = (table) => `public.${ident(table)}`;
    const wrapper = path.join(work, "restore.sql");
    const enable = { O: "ENABLE", D: "DISABLE", R: "ENABLE REPLICA", A: "ENABLE ALWAYS" };
    writeFileSync(wrapper, [
      "SET LOCAL lock_timeout = '15s';", "SET LOCAL statement_timeout = '30min';",
      `LOCK TABLE ${tables.map(qualified).join(', ')} IN ACCESS EXCLUSIVE MODE;`,
      ...tables.map((table) => `DO $empty$ BEGIN IF EXISTS (SELECT FROM ${qualified(table)} LIMIT 1) THEN RAISE EXCEPTION 'target database is not empty'; END IF; END $empty$;`),
      ...tables.map((table) => `ALTER TABLE ${qualified(table)} DISABLE TRIGGER USER;`),
      ...fks.map((fk) => `ALTER TABLE ${qualified(fk.table)} DROP CONSTRAINT ${ident(fk.name)};`),
      `\\i ${literal(sql)}`,
      "SET LOCAL search_path = public, pg_catalog;",
      ...fks.map((fk) => `ALTER TABLE ${qualified(fk.table)} ADD CONSTRAINT ${ident(fk.name)} ${fk.definition};`),
      ...fks.map((fk) => `ALTER TABLE ${qualified(fk.table)} VALIDATE CONSTRAINT ${ident(fk.name)};`),
      ...triggers.map((trigger) => `ALTER TABLE ${qualified(trigger.table)} ${enable[trigger.enabled]} TRIGGER ${ident(trigger.name)};`),
    ].join("\n") + "\n", { mode: 0o600, flag: "wx" });
    command("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "--file", wrapper], conn.env);
    console.log("ZAIPOS restore committed: verified artifact, matching schema, locked empty target, validated foreign keys and preserved trigger states");
  } finally { rmSync(work, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(`ZAIPOS restore failed: ${error.code ?? error.message}`); process.exitCode = 1; });
