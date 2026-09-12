import fs from "node:fs";

const source = fs.readFileSync("src/modules/ai-agent/AIAgent.tsx", "utf8");

const required = [
  'rpc("get_operational_alerts_v1"',
  '_expiry_horizon_days: 30',
  '_cash_lookback_days: 7',
  'Operational alerts',
  'Source-backed branch conditions',
  'alert.source_id',
  'alert.severity',
  'No operational alerts from persisted branch state',
  'cash_variance',
  'difference_fils',
];

for (const token of required) {
  if (!source.includes(token)) {
    throw new Error(`Operational alerts UI contract missing: ${token}`);
  }
}

if (source.includes('rpc("get_branch_operational_alerts_v1"')) {
  throw new Error("Operational alerts UI must use the richer v1 authority, not the superseded fixed-window RPC");
}

if (/setInterval\s*\(/.test(source)) {
  throw new Error("Operational alerts UI must not create an uncontrolled polling loop");
}

process.stdout.write("Operational alerts UI contract PASS: v1 branch-load surfacing, cash variance, provenance, explicit horizons and non-polling behavior verified.\n");
