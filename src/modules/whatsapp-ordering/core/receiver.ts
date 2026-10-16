import { parseConnectionUpdate, parseEvolutionWebhook } from "./evolution";
import type { HandleResult } from "./engine";
import type { InboundMessage } from "./types";

/**
 * Framework-agnostic Evolution API webhook receiver (works in a Supabase Edge Function,
 * Node or any Fetch-API runtime). Evolution cannot sign webhooks, so we require a shared
 * secret in a header or ?token= on the webhook URL (ASSUMPTION A6). Always answers 200 for
 * events we ignore so Evolution does not retry them; 5xx only on our own failure so it retries.
 */
export interface ReceiverDeps {
  secret: string;
  handle(msg: InboundMessage): Promise<HandleResult>;
  onSession?(s: { state: string; needsQr: boolean }): Promise<void>;
  log?(event: string, detail: object): void;
}

const safeEqual = (a: string, b: string) => {
  if (!a || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export async function receiveEvolutionWebhook(req: Request, deps: ReceiverDeps): Promise<Response> {
  const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const token = req.headers.get("x-webhook-token") ?? new URL(req.url).searchParams.get("token") ?? "";
  if (!deps.secret || !safeEqual(token, deps.secret)) return json(401, { error: "unauthorized" });
  let payload: unknown;
  try { payload = await req.json(); } catch { return json(400, { error: "bad_json" }); }
  const session = parseConnectionUpdate(payload);
  if (session) { await deps.onSession?.(session); return json(200, { ok: true, session: session.state }); }
  const msg = parseEvolutionWebhook(payload);
  if (!msg) return json(200, { ok: true, ignored: true });
  try {
    const r = await deps.handle(msg);
    return json(200, { ok: true, status: r.status });
  } catch (e) {
    deps.log?.("wa_receiver_error", { chat: msg.chatId, error: String(e) });
    return json(500, { error: "processing_failed" }); // Evolution retries; dedupe on messageId makes that safe
  }
}
