import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { command, connection, fileDigest, privateDirectory, privateFile, root, sha256 } from "./postgres-recovery.mjs";

const sentinel = "ZAIPOS_TEST_SECRET_SENTINEL";
const conn = connection(`postgresql://user:${sentinel}@127.0.0.1:5999/disposable?sslmode=require`);
test("connection credentials stay in child environment, endpoint is credential-free", () => {
  assert.equal(conn.env.PGPASSWORD, sentinel);
  assert.equal(conn.env.PGSSLMODE, "require");
  assert.equal(conn.endpoint, "127.0.0.1:5999/disposable");
  assert.equal(conn.env.ZAIPOS_DATABASE_URL, undefined);
  assert.throws(() => connection("broken"), /invalid/);
  assert.throws(() => connection("https://user:password@host/db"), /PostgreSQL/);
  assert.throws(() => connection("postgresql://host/db?password=secret"), /unsupported/);
});
test("failing child diagnostics do not disclose secrets or business rows", () => {
  assert.throws(() => command(process.execPath, ["-e", "console.error(process.env.PGPASSWORD); process.exit(1)"], conn.env), (error) => {
    assert.doesNotMatch(error.message, new RegExp(sentinel));
    assert.match(error.message, /exit 1/);
    return true;
  });
});
test("missing tools fail with a stable error category", () => {
  assert.throws(() => command("zaipos-missing-pg-tool", [], conn.env), /ENOENT/);
});
test("permissions and symlinks fail closed; streaming SHA-256 preserves exact bytes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zaipos-recovery-test-"));
  try {
    privateDirectory(dir);
    const file = path.join(dir, "data");
    writeFileSync(file, "exact 1275 fils\n", { mode: 0o600 });
    assert.equal(await fileDigest(file), sha256(readFileSync(file)));
    privateFile(file);
    chmodSync(file, 0o644);
    assert.throws(() => privateFile(file), /owner-only/);
    symlinkSync(file, path.join(dir, "link"));
    assert.throws(() => privateFile(path.join(dir, "link")), /owner-only/);
    chmodSync(dir, 0o755);
    assert.throws(() => privateDirectory(dir), /owner-only/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("backup preflight tool failure cleans reservation without publishing artifacts or secrets", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zaipos-recovery-test-"));
  try {
    const archive = path.join(dir, "backup.dump");
    const result = spawnSync(process.execPath, [path.join(root, "scripts/backup-postgres.mjs"), archive], {
      env: { ...process.env, PATH: dir, ZAIPOS_DATABASE_URL: `postgresql://user:${sentinel}@127.0.0.1:5999/db` }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT/);
    assert.doesNotMatch(result.stderr, new RegExp(sentinel));
    for (const suffix of ["", ".manifest.json", ".sha256", ".lock"]) assert.equal(existsSync(archive + suffix), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("archive validation precedes all target tools and confirmation cannot bypass integrity", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zaipos-recovery-test-"));
  try {
    const file = path.join(dir, "invalid.dump");
    for (const [suffix, content] of [["", "not a dump"], [".manifest.json", "{}"], [".sha256", "invalid"]]) writeFileSync(file + suffix, content, { mode: 0o600 });
    const result = spawnSync(process.execPath, [path.join(root, "scripts/restore-postgres.mjs"), file], {
      env: { ...process.env, PATH: dir, ZAIPOS_DATABASE_URL: `postgresql://user:${sentinel}@127.0.0.1:5999/db`, ZAIPOS_RESTORE_CONFIRM: "RESTORE_TO_EMPTY_DATABASE" }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum/);
    assert.doesNotMatch(result.stderr, new RegExp(`${sentinel}|ENOENT`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
