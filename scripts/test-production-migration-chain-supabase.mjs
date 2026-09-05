import { execFileSync } from "node:child_process";

const adminUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const templateUrl = new URL(adminUrl);
templateUrl.username = "supabase_admin";
templateUrl.password = "postgres";
templateUrl.pathname = "/template1";

// Supabase creates platform schemas per database. The production-chain harness creates
// isolated databases itself, so seed only the platform-owned schema through the image's
// privileged bootstrap role. Application migrations still install their own extensions.
execFileSync(
  "psql",
  [templateUrl.toString(), "-X", "-v", "ON_ERROR_STOP=1", "-c", "CREATE SCHEMA IF NOT EXISTS extensions;"],
  {
    encoding: "utf8",
    stdio: "inherit",
    env: { ...process.env, PGPASSWORD: "postgres" },
  },
);

await import("./test-production-migration-chain.mjs");
