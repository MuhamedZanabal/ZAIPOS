import fs from "node:fs";

const failures = [];
const requireCondition = (condition, message) => {
  if (!condition) failures.push(message);
};
const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

const packageJson = JSON.parse(read("package.json"));
const builder = JSON.parse(read("electron-builder.config.json"));
const updater = read("electron/services/updater.ts");
const electronTypes = read("electron/types.ts");
const preload = read("electron/preload.ts");
const rendererTypes = read("src/types/electron.d.ts");
const releaseWorkflow = read(".github/workflows/release.yml");
const registryMigration = read("supabase/migrations/20260907170000_device_registry.sql");
const heartbeat = read("src/lib/deviceHeartbeat.ts");
const releaseRunbook = read("docs/production-readiness/RELEASE_OPERATIONS.md");

requireCondition(builder.publish?.provider === "github", "electron-builder: GitHub publish provider is required");
requireCondition(builder.publish?.owner === "MuhamedZanabal", "electron-builder: ZAIPOS GitHub owner is required");
requireCondition(builder.publish?.repo === "ZAIPOS", "electron-builder: ZAIPOS GitHub repository is required");
requireCondition(builder.generateUpdatesFilesForAllChannels === true, "electron-builder: stable/beta updater metadata is required");
requireCondition(builder.win?.signAndEditExecutable !== false, "electron-builder: Windows executable signing must not be disabled");
requireCondition(typeof builder.artifactName === "string" && builder.artifactName.includes("${version}"), "electron-builder: versioned artifactName is required");

requireCondition(Boolean(packageJson.scripts?.["release:windows"]), "package.json: release:windows script is required");
requireCondition(packageJson.scripts?.["release:windows"]?.includes("require-windows-signing"), "package.json: production release must fail closed without signing credentials");
requireCondition(Boolean(packageJson.scripts?.["test:release-contract"]), "package.json: release contract script is required");

for (const marker of [
  "workflow_dispatch:",
  "tags:",
  "windows-latest",
  "Test production PostgreSQL migration chain",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "GH_TOKEN",
  "release:windows",
  "Unsigned production releases are forbidden",
]) {
  requireCondition(releaseWorkflow.includes(marker), `.github/workflows/release.yml: missing ${marker}`);
}

requireCondition(updater.includes("autoDownload = false"), "updater: downloads must require operator approval");
requireCondition(updater.includes("allowPrerelease"), "updater: stable/beta channel policy is required");
requireCondition(updater.includes("DOWNLOAD_UPDATE"), "updater: explicit download handler is required");
requireCondition(electronTypes.includes("DOWNLOAD_UPDATE"), "Electron IPC: download-update handler is required");
requireCondition(preload.includes("downloadUpdate"), "Electron preload: explicit download API is required");
requireCondition(rendererTypes.includes("downloadUpdate"), "Renderer bridge: explicit download API is required");

for (const marker of ["CREATE TABLE public.devices", "update_channel", "app_version", "last_seen_at", "register_device_heartbeat"]) {
  requireCondition(registryMigration.includes(marker), `device registry migration: missing ${marker}`);
}
requireCondition(heartbeat.includes("register_device_heartbeat"), "device heartbeat client is required");
requireCondition(heartbeat.includes("getAppVersion"), "device heartbeat must report the packaged app version");

for (const marker of ["Stable channel", "Beta channel", "Signing", "Rollback", "CSC_LINK", "CSC_KEY_PASSWORD"]) {
  requireCondition(releaseRunbook.includes(marker), `release runbook: missing ${marker}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Production release contract PASS: signed GitHub publishing, approval-based updates, channels, rollback, and fleet heartbeat are configured.");
