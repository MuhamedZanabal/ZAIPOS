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
const ci = read('.github/workflows/ci.yml');

for (const marker of [
  'Classic Cappuccino',
  'Cheesecake de Fresa',
  '71% margin',
  "I analyzed this month's sales",
  'Connected to your inventory, sales, and CRM',
  'Querying data',
  'setTimeout',
]) {
  requireCondition(!workspace.includes(marker), `AI workspace contains fabricated behavior: ${marker}`);
}
requireCondition(workspace.includes('Read-only safety mode'), 'AI workspace must disclose read-only safety mode');
requireCondition(workspace.includes('No source query was executed'), 'AI workspace must disclose that no evidence query occurred');
requireCondition(workspace.includes('Fact') && workspace.includes('Inference') && workspace.includes('Recommendation'), 'AI workspace must distinguish fact, inference, and recommendation');

for (const marker of ['name: "create_order"', 'ai_create_digital_order', 'handoff_to_human', 'new OpenAI', 'OPENROUTER_API_KEY']) {
  requireCondition(!orderAgent.includes(marker), `AI edge function retains autonomous capability: ${marker}`);
}
requireCondition(orderAgent.includes("P0_AI_MODE = 'read_only'"), 'AI edge function must fail closed in read-only mode');
requireCondition(!settings.includes('create_order'), 'AI settings must not instruct autonomous order creation');
requireCondition(!settings.includes('handoff_to_human'), 'AI settings must not expose hidden write tools');
requireCondition(settings.includes('Read-only safety mode'), 'AI settings must disclose P0 mode');
requireCondition(embedding.includes('has_branch_role'), 'embedding endpoint must enforce server-side tenant/branch role authorization');

for (const marker of ['ai_search_catalog', 'ai_quote_order', 'ai_create_digital_order', 'ai_handoff_to_human', 'service_role']) {
  requireCondition(lockdown.includes(marker), `AI RPC lockdown missing ${marker}`);
}
requireCondition(ci.includes('Test P0 AI safety'), 'CI must enforce the P0 AI safety contract');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('P0 AI safety PASS: no fake operational claims, no autonomous tools, fail-closed RPC grants, and server-side role checks.');
