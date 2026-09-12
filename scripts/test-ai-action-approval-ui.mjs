import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/modules/ai-agent/AIAgent.tsx", import.meta.url), "utf8");

const requiredPatterns = [
  [/\.from\(["']ai_action_requests["']\)/, "AI review UI must read the authoritative approval queue"],
  [/\.eq\(["']branch_id["'],\s*branchId/, "AI review UI must scope queue reads to the selected branch"],
  [/review_ai_action_v1/, "AI review UI must use the server-authoritative review RPC"],
  [/p_request_id/, "AI review UI must bind reviews to a request ID"],
  [/p_approve/, "AI review UI must explicitly bind approve vs reject"],
  [/p_reason/, "AI review UI must submit human review rationale"],
  [/p_operation_id/, "AI review UI must use an idempotent review operation ID"],
  [/pending/, "AI review UI must expose pending state"],
  [/approved/, "AI review UI must expose approved state"],
  [/rejected/, "AI review UI must expose rejected state"],
  [/payload/, "AI review UI must expose the immutable proposed-action payload"],
  [/evidence/, "AI review UI must expose immutable supporting evidence"],
];

for (const [pattern, message] of requiredPatterns) {
  if (!pattern.test(source)) throw new Error(message);
}

const forbiddenPatterns = [
  [/request_ai_action_v1/, "This slice must not add a client-side AI request producer"],
  [/ai_quote_order/, "Approval UI must not restore legacy AI mutation RPCs"],
  [/ai_create_digital_order/, "Approval UI must not restore legacy AI mutation RPCs"],
  [/\.from\(["']ai_action_requests["']\)\s*\.update\(/s, "Approval UI must not directly update approval rows"],
  [/\.from\(["']ai_action_requests["']\)\s*\.insert\(/s, "Approval UI must not directly insert approval rows"],
  [/\.from\(["']ai_action_requests["']\)\s*\.delete\(/s, "Approval UI must not directly delete approval rows"],
];

for (const [pattern, message] of forbiddenPatterns) {
  if (pattern.test(source)) throw new Error(message);
}

process.stdout.write("AI action approval UI static contract passed.\n");
