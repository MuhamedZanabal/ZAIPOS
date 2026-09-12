import fs from 'node:fs';

const failures = [];
const requireCondition = (condition, message) => {
  if (!condition) failures.push(message);
};
const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

const workspace = read('src/modules/ai-agent/AIAgent.tsx');
const settings = read('src/modules/settings/AiAgentSettings.tsx');
const orderAgent = read('supabase/functions/ai-order-agent/index.ts');
const embedding = read('supabase/functions/embed-knowledge-doc/index.ts');
const lockdown = read('supabase/migrations/20260907180000_ai_read_only_lockdown.sql');
const readController = read('supabase/migrations/20260912173000_ai_read_reporting_context.sql');
const ci = read('.github/workflows/ci.yml');

for (const marker of [
  'Classic Cappuccino',
  'Cheesecake de Fresa',
  '71% margin',
  "I analyzed this month's sales",
  'Connected to your inventory, sales, and CRM',
  'setTimeout',
]) {
  requireCondition(!workspace.includes(marker), `AI workspace contains fabricated behavior: ${marker}`);
}

requireCondition(workspace.includes('ai_read_reporting_context_v1'), 'AI workspace must use the source-backed read controller');
requireCondition(/Source-backed|source-backed/.test(workspace), 'AI workspace must disclose source-backed mode');
requireCondition(workspace.includes('No fallback or fabricated values are shown'), 'AI workspace must fail closed when evidence retrieval fails');
requireCondition(workspace.includes('Evidence'), 'AI workspace must expose evidence metadata');
requireCondition(!workspace.includes('P0 LOCKED'), 'P0 locked badge must be removed after source-backed read activation');

for (const marker of ['ai_create_digital_order', 'ai_quote_order', 'ai_handoff_to_human', 'create_order']) {
  requireCondition(!workspace.includes(marker), `AI workspace exposes forbidden mutation capability: ${marker}`);
}

for (const marker of ['name: "create_order"', 'ai_create_digital_order', 'handoff_to_human', 'new OpenAI', 'OPENROUTER_API_KEY']) {
  requireCondition(!orderAgent.includes(marker), `AI edge function retains autonomous capability: ${marker}`);
}
requireCondition(orderAgent.includes("P0_AI_MODE = 'read_only'"), 'legacy AI edge function must remain fail closed');
requireCondition(!settings.includes('create_order'), 'AI settings must not instruct autonomous order creation');
requireCondition(!settings.includes('handoff_to_human'), 'AI settings must not expose hidden write tools');
requireCondition(/Source-backed read only/.test(settings), 'AI settings must disclose source-backed read-only mode');
requireCondition(embedding.includes('has_branch_role'), 'embedding endpoint must enforce server-side tenant/branch role authorization');

for (const marker of ['get_branch_reporting_snapshot_v1', 'SECURITY DEFINER', 'REVOKE ALL', 'authenticated', "'read_only'"]) {
  requireCondition(readController.includes(marker), `AI read-controller migration missing safety marker: ${marker}`);
}
requireCondition(!readController.includes('ai_create_digital_order'), 'AI read controller must not invoke legacy order mutation RPC');
requireCondition(!readController.includes('ai_quote_order'), 'AI read controller must not invoke legacy quote RPC');

for (const marker of ['ai_search_catalog', 'ai_quote_order', 'ai_create_digital_order', 'ai_handoff_to_human', 'service_role']) {
  requireCondition(lockdown.includes(marker), `AI RPC lockdown missing ${marker}`);
}
requireCondition(ci.includes('Test P0 AI safety'), 'CI must continue enforcing the AI safety regression contract');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('AI safety PASS: source-backed read controller enabled, fabricated claims absent, legacy autonomous tools remain fail closed and revoked.');
