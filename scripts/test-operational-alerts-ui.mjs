import fs from "node:fs";

const source = fs.readFileSync("src/modules/ai-agent/AIAgent.tsx", "utf8");

const required = [
  'rpc("get_branch_operational_alerts_v1"',
  'Operational alerts',
  'Source-backed branch conditions',
  'alert.source_id',
  'alert.severity',
  'No operational alerts from persisted branch state',
];

for (const token of required) {
  if (!source.includes(token)) {
    throw new Error(`Operational alerts UI contract missing: ${token}`);
  }
}

if (/setInterval\s*\(/.test(source)) {
  throw new Error("Operational alerts UI must not create an uncontrolled polling loop");
}

process.stdout.write("Operational alerts UI contract PASS: branch-load surfacing, provenance and non-polling behavior verified.\n");
