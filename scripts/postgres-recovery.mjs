import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const ident = (value) => `"${String(value).replaceAll('"', '""')}"`;
export const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function connection(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid PostgreSQL connection URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new Error("PostgreSQL host and database are required");
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("PG") && !key.startsWith("ZAIPOS_") && !key.startsWith("POSTGRES_")));
  Object.assign(env, {
    PGHOST: url.hostname, PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGAPPNAME: "zaipos-disaster-recovery", PGCONNECT_TIMEOUT: "15",
  });
  const options = { sslmode: "PGSSLMODE", sslrootcert: "PGSSLROOTCERT", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY", channel_binding: "PGCHANNELBINDING", sslpassword: "PGSSLPASSWORD" };
  for (const [key, val] of url.searchParams) {
    if (!options[key]) throw new Error("unsupported connection option; use an explicit direct PostgreSQL URL");
    env[options[key]] = val;
  }
  return { env, endpoint: `${url.hostname}:${env.PGPORT}/${encodeURIComponent(env.PGDATABASE)}` };
}

// Never echo child stderr or Error.message: COPY errors can contain entire
// business rows, and connection errors can contain authentication data.
export function command(tool, args, env, stdout = "pipe") {
  const result = spawnSync(tool, args, {
    env, encoding: "utf8", stdio: ["ignore", stdout, "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${tool} failed (${result.error?.code ?? `exit ${result.status}`}); recovery stopped; inspect restricted database diagnostics`);
  }
  return result.stdout?.trim() ?? "";
}
export const query = (conn, sql) => command("psql", ["-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql], conn.env);
export const jsonQuery = (conn, sql) => JSON.parse(query(conn, sql));
export function databaseIdentity(conn) {
  return { endpoint: conn.endpoint, ...jsonQuery(conn, `SELECT json_build_object(
    'database', current_database(), 'serverAddress', inet_server_addr()::text,
    'serverPort', inet_server_port(), 'postgresMajor', current_setting('server_version_num')::int / 10000)::text;`) };
}
export function schemaDigest(conn) {
  // Ignore random psql restriction tokens and client/server version comments;
  // retain all DDL and RLS definitions.
  const schema = command("pg_dump", ["--schema-only", "--schema=public", "--no-owner", "--no-privileges"], conn.env)
    .split(/\r?\n/).filter((line) => !/^\\(?:un)?restrict /.test(line) && !/^-- Dumped (?:from|by) /.test(line)).join("\n");
  return sha256(schema);
}
export function migrationEvidence() {
  const dir = path.join(root, "supabase/migrations");
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  return { latest: files.at(-1), count: files.length,
    sha256: sha256(files.map((name) => `${name}:${sha256(readFileSync(path.join(dir, name)))}`).join("\n")) };
}
export async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export function privateFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("backup artifacts must be regular owner-only files (0600)");
  }
  return stat;
}
export function privateDirectory(dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("backup directory must be owner-only (0700)");
  }
}
export function assertSupportedSchema(conn) {
  // Foreign data and materialized views need an explicit recovery strategy.
  if (query(conn, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('f','m');") !== "0") {
    throw new Error("unsupported recovery schema: foreign tables or materialized views require a reviewed recovery strategy");
  }
}
