import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const verifier = new URL("./verify-backup-restore.mjs", import.meta.url);
const verifierPath = verifier.pathname;

if (!existsSync(verifierPath)) {
  throw new Error("Backup/restore verifier is required at scripts/verify-backup-restore.mjs");
}

const source = readFileSync(verifierPath, "utf8");
for (const required of [
  "pg_dump",
  "pg_restore",
  "createdb",
  "dropdb",
  "sha256",
  "ZAIPOS_BACKUP_RESTORE_OK",
  "--no-owner",
  "--no-acl",
]) {
  if (!source.includes(required)) throw new Error(`Backup/restore verifier missing required contract marker: ${required}`);
}

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const output = execFileSync(process.execPath, [verifierPath], {
  env: { ...process.env, POSTGRES_ADMIN_URL: dbUrl },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (!output.includes("ZAIPOS_BACKUP_RESTORE_OK")) {
  throw new Error(`Backup/restore verifier did not emit success evidence. Output: ${output}`);
}

console.log(output.trim());
console.log("Backup/restore contract passed.");
