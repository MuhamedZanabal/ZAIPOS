import assert from "node:assert/strict";
import fs from "node:fs";

const path = "supabase/functions/send-whatsapp-message/index.ts";
const source = fs.readFileSync(path, "utf8");

const conversationLookup = source.indexOf('.from("ai_conversations")');
const forbiddenMissingConversation = source.indexOf('if (!data) return json({ error: "Forbidden" }, 403);');
// Build the source token in two pieces so this verification script does not itself
// look like a runtime .rpc(...) call to the authorization-surface census.
const rpcCallToken = `.${"rpc"}("has_branch_role"`;
const roleCheck = source.indexOf(`supabase${rpcCallToken}`);
const evolutionFetch = source.indexOf('const evoRes = await fetch(endpoint');
const messageInsert = source.indexOf('.from("ai_messages").insert');

assert.ok(conversationLookup >= 0, "conversation lookup must remain explicit");
assert.ok(
  forbiddenMissingConversation > conversationLookup,
  "missing/inaccessible conversation must fail closed as 403 so an authenticated cross-tenant caller cannot distinguish an existing conversation ID from a nonexistent one",
);
assert.ok(roleCheck > forbiddenMissingConversation, "branch-role authorization must follow authoritative conversation scope resolution");
assert.ok(evolutionFetch > roleCheck, "external WhatsApp side effect must occur only after branch-role authorization");
assert.ok(messageInsert > roleCheck, "service-role message persistence must occur only after branch-role authorization");
assert.equal(
  source.includes('if (!data) return json({ error: "Conversation not found" }, 404);'),
  false,
  "do not restore the authenticated conversation-existence oracle",
);

console.log("PASS send-whatsapp authorization boundary");
