import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const migrationsDir = path.resolve("supabase/migrations");

const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error("No migrations found in supabase/migrations");
  process.exit(1);
}

const filenameRegex = /^\d{14}_.+\.sql$/;
const seen = new Set();

for (const file of files) {
  if (!filenameRegex.test(file)) {
    console.error(`Invalid migration name: ${file}`);
    process.exit(1);
  }
  if (seen.has(file)) {
    console.error(`Duplicate migration: ${file}`);
    process.exit(1);
  }
  seen.add(file);

  const fullPath = path.join(migrationsDir, file);
  const content = await readFile(fullPath, "utf8");
  if (!content.trim()) {
    console.error(`Empty migration: ${file}`);
    process.exit(1);
  }
}

console.log(`OK: ${files.length} migrations validated.`);
