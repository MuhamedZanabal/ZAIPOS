import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertSupportedSchema, command, connection, databaseIdentity, fileDigest, migrationEvidence, privateDirectory, root, schemaDigest } from "./postgres-recovery.mjs";

async function main() {
  if (!process.argv[2]) throw new Error("usage: node scripts/backup-postgres.mjs <archive.dump>");
  if (!process.env.ZAIPOS_DATABASE_URL) throw new Error("ZAIPOS_DATABASE_URL is required");
  process.umask(0o077);
  const archive = path.resolve(process.argv[2]);
  if (/[\r\n]/.test(archive)) throw new Error("archive path cannot contain newlines");
  privateDirectory(path.dirname(archive));
  const outputs = [archive, `${archive}.manifest.json`, `${archive}.sha256`];
  if (outputs.some(existsSync)) throw new Error("backup already exists; refusing overwrite");
  const lock = `${archive}.lock`;
  mkdirSync(lock, { mode: 0o700 });
  const published = [];
  try {
    const conn = connection(process.env.ZAIPOS_DATABASE_URL);
    assertSupportedSchema(conn);
    const startedAt = new Date().toISOString();
    const source = databaseIdentity(conn);
    const schemaSha256 = schemaDigest(conn);
    const staged = path.join(lock, "archive.dump");
    command("pg_dump", ["--format=custom", "--data-only", "--schema=public", "--no-owner", "--no-privileges", "--file", staged], conn.env);
    if (schemaDigest(conn) !== schemaSha256) throw new Error("source schema changed during backup; retry during a migration freeze");
    const digest = await fileDigest(staged);
    let gitSha = process.env.GITHUB_SHA ?? null;
    if (!gitSha) {
      try { gitSha = command("git", ["-C", root, "rev-parse", "HEAD"], conn.env); } catch { /* recorded as unavailable */ }
    }
    const manifest = {
      formatVersion: 1, status: "complete", startedAt, completedAt: new Date().toISOString(),
      source, schemaSha256, migrationChain: migrationEvidence(),
      application: { version: JSON.parse(readFileSync(path.join(root, "package.json"))).version, gitSha },
      scope: "public-data", externalBoundaries: ["Supabase Auth", "Storage metadata and objects", "platform roles and secrets", "unsynchronized device queues"],
      artifact: { name: path.basename(archive), format: "postgres-custom", sha256: digest, bytes: statSync(staged).size, permissions: "0600" },
    };
    const metadata = path.join(lock, "manifest.json");
    writeFileSync(metadata, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const checksum = path.join(lock, "sha256");
    writeFileSync(checksum, `${digest}  ${path.basename(archive)}\n${await fileDigest(metadata)}  ${path.basename(archive)}.manifest.json\n`, { mode: 0o600, flag: "wx" });
    for (const file of [staged, metadata, checksum]) {
      const fd = openSync(file, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    for (const [index, file] of [staged, metadata, checksum].entries()) {
      linkSync(file, outputs[index]); // atomic no-clobber publication, checksum last
      published.push(outputs[index]);
    }
    console.log("ZAIPOS backup complete: archive, manifest and SHA-256 evidence published with owner-only permissions");
  } catch (error) {
    for (const file of published) rmSync(file, { force: true });
    throw error;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(`ZAIPOS backup failed: ${error.code ?? error.message}`); process.exitCode = 1; });
