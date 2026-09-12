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
  "customer_credit_ledger_entries",
  "customer_loyalty_ledger_entries",
];

function psql(statement, { capture = true } = {}) {
  return execFileSync(
    "psql",
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...(capture ? ["-Atq"] : []), "-c", statement],
    {
      cwd: root,
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
  return criticalTables.filter((table) => scalar(`SELECT to_regclass('public.${table}') IS NOT NULL;`) === "t");
}

function tableFingerprint(table) {
  const quoted = quoteIdentifier(table);
  return scalar(`
    SELECT count(*)::text || ':' || md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), ''))
    FROM public.${quoted} AS t;
  `);
}

function captureManifest() {
  return Object.fromEntries(existingCriticalTables().map((table) => [table, tableFingerprint(table)]));
}

function truncatePublicData() {
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

  const before = captureManifest();
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
  assertEqual("backup archive is owner-only", String(statSync(archive).mode & 0o077), "0");
  assertTruthy("checksum sidecar created", readFileSync(`${archive}.sha256`, "utf8").includes(path.basename(archive)));

  expectFailure(
    "backup refuses accidental overwrite",
    process.execPath,
    [backupScript, archive],
    { ZAIPOS_DATABASE_URL: dbUrl },
    /already exists|overwrite/i,
  );

  truncatePublicData();
  assertEqual("restore target is empty", scalar("SELECT count(*)::text FROM public.tenants;"), "0");

  execFileSync(process.execPath, [restoreScript, archive], {
    cwd: root,
    env: {
      ...process.env,
      ZAIPOS_DATABASE_URL: dbUrl,
      ZAIPOS_RESTORE_CONFIRM: "RESTORE_TO_EMPTY_DATABASE",
    },
    stdio: "inherit",
  });

  const after = captureManifest();
  assertEqual("critical data manifest round-trips exactly", JSON.stringify(after), JSON.stringify(before));
  assertEqual("restored fixture selling price fils", scalar(`SELECT price_fils::text FROM public.products WHERE id='${I.product}'`), "1275");
  assertEqual("restored fixture cost fils", scalar(`SELECT cost_fils::text FROM public.products WHERE id='${I.product}'`), "825");
  assertEqual("restored fixture quantity", scalar(`SELECT quantity::text FROM public.inventory_stocks WHERE product_id='${I.product}' AND inventory_center_id='${I.center}'`), "7.500");

  copyFileSync(archive, tamperedArchive);
  copyFileSync(`${archive}.sha256`, `${tamperedArchive}.sha256`);
  const tampered = Buffer.from(readFileSync(tamperedArchive));
  tampered[Math.max(0, tampered.length - 1)] ^= 0xff;
  writeFileSync(tamperedArchive, tampered);

  expectFailure(
    "restore rejects tampered archive before mutation",
    process.execPath,
    [restoreScript, tamperedArchive],
    {
      ZAIPOS_DATABASE_URL: dbUrl,
      ZAIPOS_RESTORE_CONFIRM: "RESTORE_TO_EMPTY_DATABASE",
    },
    /checksum|integrity/i,
  );

  console.log(`Backup/restore contract passed across ${Object.keys(before).length} critical tables.`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
