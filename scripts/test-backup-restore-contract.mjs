import { createHash } from "node:crypto";
import { connection, query, schemaDigest, literal, command } from "./postgres-recovery.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const restoreUrl = process.env.POSTGRES_RESTORE_TEST_URL;
if (process.env.ZAIPOS_RECOVERY_REHEARSAL !== "DISPOSABLE_TEST_DATABASES" || !restoreUrl) {
  throw new Error("Rehearsal requires two explicitly acknowledged disposable test databases");
}
const sourceConnection = connection(dbUrl);
const targetConnection = connection(restoreUrl);
if (![sourceConnection, targetConnection].every((c) => ["127.0.0.1", "localhost"].includes(c.env.PGHOST)) || sourceConnection.endpoint === targetConnection.endpoint) {
  throw new Error("Rehearsal requires distinct local disposable database endpoints");
}
let activeUrl = dbUrl;
const backupScript = path.join(root, "scripts", "backup-postgres.mjs");
const restoreScript = path.join(root, "scripts", "restore-postgres.mjs");
const runbook = path.join(root, "docs", "production-readiness", "BACKUP_RESTORE.md");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "zaipos-backup-restore-"));
const archive = path.join(tempDir, "zaipos-business-data.dump");
const tamperedArchive = path.join(tempDir, "zaipos-business-data-tampered.dump");

const I = {
  user: "3a000000-0000-0000-0000-000000000701",
  tenant: "1a000000-0000-0000-0000-000000000701",
  branch: "2a000000-0000-0000-0000-000000000701",
  center: "4a000000-0000-0000-0000-000000000701",
  product: "5a000000-0000-0000-0000-000000000701",
};

const criticalTables = [
  "tenants",
  "branches",
  "profiles",
  "user_roles",
  "employees",
  "products",
  "product_barcodes",
  "product_prices",
  "product_financial_operations",
  "inventory_centers",
  "inventory_stocks",
  "inventory_movements",
  "inventory_operations",
  "sales",
  "sale_items",
  "payments",
  "checkout_operations",
  "sale_returns",
  "sale_return_items",
  "sale_voids",
  "audit_logs",
  "supplier_ledger_entries",
  "customer_credit_entries",
  "customer_loyalty_ledger",
];

function psql(statement, { capture = true } = {}) {
  return execFileSync(
    "psql",
    ["-X", "-v", "ON_ERROR_STOP=1", ...(capture ? ["-Atq"] : []), "-c", statement],
    {
      cwd: root,
      env: connection(activeUrl).env,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    },
  );
}

function scalar(statement) {
  return psql(statement).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTruthy(label, value) {
  if (!value) throw new Error(`${label}: expected a truthy value`);
}

function expectFailure(label, command, args, env, pattern) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status === 0) throw new Error(`${label}: expected command to fail`);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!pattern.test(output)) {
    throw new Error(`${label}: wrong rejection: ${output}`);
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function existingCriticalTables() {
  const tables = JSON.parse(scalar("SELECT COALESCE(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public';"));
  for (const required of criticalTables) {
    if (!tables.includes(required)) throw new Error(`Required recovery table missing: ${required}`);
  }
  return tables;
}
function tableFingerprint(table) {
  const rows = psql(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM public.${quoteIdentifier(table)} t;`).trim();
  return createHash('sha256').update(rows).digest('hex');
}
function captureManifest() {
  const result = Object.fromEntries(existingCriticalTables().map((table) => [table, tableFingerprint(table)]));
  const sequences = JSON.parse(scalar("SELECT COALESCE(json_agg(sequencename ORDER BY sequencename),'[]') FROM pg_sequences WHERE schemaname='public';"));
  for (const sequence of sequences) result[`sequence:${sequence}`] = scalar(`SELECT last_value::text || ':' || is_called::text FROM public.${quoteIdentifier(sequence)};`);
  return result;
}

function truncatePublicData() {
  if (activeUrl !== restoreUrl) throw new Error("Refusing to truncate the source database");
  const tables = scalar(`
    SELECT COALESCE(string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename), '')
    FROM pg_tables
    WHERE schemaname = 'public';
  `);
  if (!tables) throw new Error("No public tables found for restore rehearsal");
  psql(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`, { capture: false });
}

try {
  // RED gate: these operational capabilities must exist before the contract can pass.
  for (const required of [backupScript, restoreScript, runbook]) {
    try {
      accessSync(required, constants.R_OK);
    } catch {
      throw new Error(`Backup/restore capability missing: ${path.relative(root, required)}`);
    }
  }

  assertEqual("production schema is migrated", scalar("SELECT to_regclass('public.products') IS NOT NULL;"), "t");
  assertEqual("exact-fils product column exists", scalar("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='price_fils');"), "t");

  psql(`
    INSERT INTO auth.users(id,email,raw_user_meta_data)
    VALUES ('${I.user}','backup-restore@zaipos.test','{}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode)
    VALUES ('${I.tenant}','Backup Restore Tenant','backup-restore-tenant','BHD',10,false)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.branches(id,tenant_id,name,status)
    VALUES ('${I.branch}','${I.tenant}','Backup Restore Branch','active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role)
    VALUES ('${I.user}','${I.tenant}',NULL,'owner')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.inventory_centers(id,tenant_id,branch_id,name,type,status)
    VALUES ('${I.center}','${I.tenant}','${I.branch}','Backup Restore Center','warehouse','active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.products(id,tenant_id,name,product_type,sku,price,cost,tax_rate,status,barcode)
    VALUES ('${I.product}','${I.tenant}','Backup Restore Product','simple','BKP-RESTORE-001',1.275,0.825,10,'active',NULL)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.inventory_stocks(tenant_id,branch_id,inventory_center_id,product_id,quantity)
    VALUES ('${I.tenant}','${I.branch}','${I.center}','${I.product}',7.500)
    ON CONFLICT (inventory_center_id, product_id) DO UPDATE SET quantity=EXCLUDED.quantity;
  `, { capture: false });

  assertEqual("fixture selling price fils", scalar(`SELECT price_fils::text FROM public.products WHERE id='${I.product}'`), "1275");
  assertEqual("fixture cost fils", scalar(`SELECT cost_fils::text FROM public.products WHERE id='${I.product}'`), "825");
  assertEqual("fixture quantity", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE product_id='${I.product}' AND inventory_center_id='${I.center}'`), "7.500");

  // Populate real exact-fils ledger, payable, return/void and replay evidence
  // using the existing PostgreSQL runtime contracts against the source only.
  for (const script of ["test-customer-credit-subledger-postgres.mjs", "test-supplier-subledger-postgres.mjs", "test-customer-loyalty-ledger-runtime-postgres.mjs"]) {
    execFileSync(process.execPath, [path.join(root, "scripts", script)], { env: { ...process.env, POSTGRES_ADMIN_URL: dbUrl }, stdio: "pipe" });
  }
  const before = captureManifest();
  for (const table of ["sales", "sale_items", "payments", "supplier_ledger_entries", "customer_credit_entries", "customer_loyalty_ledger", "audit_logs"]) {
    assertTruthy(`nonempty recovery fixture ${table}`, Number(scalar(`SELECT count(*) FROM public.${table};`)) > 0);
  }
  const sourceSchema = schemaDigest(sourceConnection);
  const sourceDdl = command("pg_dump", ["--schema-only", "--schema=public", "--no-owner", "--no-privileges"], sourceConnection.env);
  assertTruthy("critical manifest includes products", before.products);
  assertTruthy("critical manifest includes inventory", before.inventory_stocks);

  execFileSync(process.execPath, [backupScript, archive], {
    cwd: root,
    env: {
      ...process.env,
      ZAIPOS_DATABASE_URL: dbUrl,
      ZAIPOS_BACKUP_SOURCE: "ci-backup-restore-contract",
    },
    stdio: "inherit",
  });

  assertTruthy("backup archive created", statSync(archive).size > 0);
  const metadata = JSON.parse(readFileSync(`${archive}.manifest.json`, "utf8"));
  assertEqual("manifest format", metadata.formatVersion, 1);
  assertTruthy("schema compatibility fingerprint", /^[a-f0-9]{64}$/.test(metadata.schemaSha256));
  assertTruthy("source identity", metadata.source.database && metadata.source.endpoint);
  assertTruthy("backup timestamp", Number.isFinite(Date.parse(metadata.startedAt)));
  assertEqual("archive byte size", metadata.artifact.bytes, statSync(archive).size);
  assertEqual("backup archive is owner-only", String(statSync(archive).mode & 0o077), "0");
  assertTruthy("checksum sidecar created", readFileSync(`${archive}.sha256`, "utf8").includes(path.basename(archive)));

  expectFailure(
    "backup refuses accidental overwrite",
    process.execPath,
    [backupScript, archive],
    { ZAIPOS_DATABASE_URL: dbUrl },
    /already exists|overwrite/i,
  );

  // Auth is an explicit provider boundary. Seed ONLY synthetic auth identities
  // independently in the recovery provider before restoring public business data.
  const authIds = JSON.parse(scalar("SELECT json_agg(id::text ORDER BY id) FROM auth.users;"));
  activeUrl = restoreUrl;
  for (const id of authIds) psql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES (${literal(id)},${literal(id + '@recovery.test')},'{}') ON CONFLICT(id) DO NOTHING;`);
  truncatePublicData();
  assertEqual("restore target is empty", scalar("SELECT count(*)::text FROM public.tenants;"), "0");

  execFileSync(process.execPath, [restoreScript, archive], {
    cwd: root,
    env: {
      ...process.env,
      ZAIPOS_DATABASE_URL: restoreUrl,
      ZAIPOS_RESTORE_TARGET: targetConnection.endpoint,
      ZAIPOS_RESTORE_CONFIRM: "RESTORE_TO_EMPTY_DATABASE",
    },
    stdio: "inherit",
  });

  const after = captureManifest();
  if (schemaDigest(targetConnection) !== sourceSchema) {
    writeFileSync(path.join(tempDir, "source.sql"), sourceDdl);
    writeFileSync(path.join(tempDir, "target.sql"), command("pg_dump", ["--schema-only", "--schema=public", "--no-owner", "--no-privileges"], targetConnection.env));
    const difference = spawnSync("diff", ["-u", path.join(tempDir, "source.sql"), path.join(tempDir, "target.sql")], { encoding: "utf8" });
    console.error(difference.stdout);
  }
  assertEqual("restored schema and trigger states preserved", schemaDigest(targetConnection), sourceSchema);
  activeUrl = dbUrl;
  assertEqual("source untouched by restore rehearsal", JSON.stringify(captureManifest()), JSON.stringify(before));
  activeUrl = restoreUrl;
  assertEqual("critical data manifest round-trips exactly", JSON.stringify(after), JSON.stringify(before));
  assertEqual("restored fixture selling price fils", scalar(`SELECT price_fils::text FROM public.products WHERE id='${I.product}'`), "1275");
  assertEqual("restored fixture cost fils", scalar(`SELECT cost_fils::text FROM public.products WHERE id='${I.product}'`), "825");
  assertEqual("restored fixture quantity", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE product_id='${I.product}' AND inventory_center_id='${I.center}'`), "7.500");

  copyFileSync(archive, tamperedArchive);
  copyFileSync(`${archive}.sha256`, `${tamperedArchive}.sha256`);
  copyFileSync(`${archive}.manifest.json`, `${tamperedArchive}.manifest.json`);
  const tampered = Buffer.from(readFileSync(tamperedArchive));
  tampered[Math.max(0, tampered.length - 1)] ^= 0xff;
  writeFileSync(tamperedArchive, tampered);

  expectFailure(
    "restore rejects tampered archive before mutation",
    process.execPath,
    [restoreScript, tamperedArchive],
    {
      ZAIPOS_DATABASE_URL: restoreUrl,
      ZAIPOS_RESTORE_TARGET: targetConnection.endpoint,
      ZAIPOS_RESTORE_CONFIRM: "RESTORE_TO_EMPTY_DATABASE",
    },
    /checksum|integrity/i,
  );

  const restoreEnv = { ZAIPOS_DATABASE_URL: restoreUrl, ZAIPOS_RESTORE_TARGET: targetConnection.endpoint, ZAIPOS_RESTORE_CONFIRM: "RESTORE_TO_EMPTY_DATABASE" };
  expectFailure("explicit confirmation required", process.execPath, [restoreScript, archive], { ...restoreEnv, ZAIPOS_RESTORE_CONFIRM: "" }, /confirmation/i);
  expectFailure("wrong endpoint rejected", process.execPath, [restoreScript, archive], { ...restoreEnv, ZAIPOS_RESTORE_TARGET: "wrong-target" }, /target identity/i);
  expectFailure("source target rejected", process.execPath, [restoreScript, archive], { ...restoreEnv, ZAIPOS_DATABASE_URL: dbUrl, ZAIPOS_RESTORE_TARGET: sourceConnection.endpoint }, /source database/i);
  expectFailure("nonempty target rejected", process.execPath, [restoreScript, archive], restoreEnv, /psql failed/i);
  assertEqual("failed nonempty restore preserves all rows", JSON.stringify(captureManifest()), JSON.stringify(after));
  psql("ALTER TABLE public.products ADD COLUMN recovery_schema_mismatch text;");
  expectFailure("schema mismatch rejected", process.execPath, [restoreScript, archive], restoreEnv, /schema mismatch/i);
  psql("ALTER TABLE public.products DROP COLUMN recovery_schema_mismatch;");
  // PostgreSQL retains a dropped attribute internally but pg_dump DDL is identical.
  truncatePublicData();
  const empty = captureManifest();
  psql(`DELETE FROM auth.users WHERE id=${literal(I.user)};`);
  expectFailure("missing external Auth identity rolls back entire restore", process.execPath, [restoreScript, archive], restoreEnv, /psql failed/i);
  assertEqual("failed FK restore leaves target empty", JSON.stringify(captureManifest()), JSON.stringify(empty));
  assertEqual("failed restore rolls back trigger and FK DDL", schemaDigest(targetConnection), sourceSchema);
  psql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES (${literal(I.user)},'recovery-retry@zaipos.test','{}');`);
  truncatePublicData(); // remove profile generated by the provider's signup trigger
  execFileSync(process.execPath, [restoreScript, archive], { cwd: root, env: { ...process.env, ...restoreEnv }, stdio: "inherit" });
  assertEqual("repeated restore exactly preserves full state", JSON.stringify(captureManifest()), JSON.stringify(before));
  activeUrl = dbUrl;
  assertEqual("source still untouched after failure and retry", JSON.stringify(captureManifest()), JSON.stringify(before));
  console.log(`Backup/restore contract passed across ${Object.keys(before).length} critical tables.`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
