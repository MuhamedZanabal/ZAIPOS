import type { InboundMessage } from "./types";

/**
 * Normalise an Evolution API "messages.upsert" webhook into an InboundMessage.
 * Mirrors the field fallbacks in supabase/functions/evolution-webhook. Returns null for
 * anything we must not answer: our own messages, groups, broadcasts/status, non-message events.
 */
export function parseEvolutionWebhook(payload: any): InboundMessage | null {
  const event = String(payload?.event ?? payload?.type ?? "").toLowerCase();
  if (event && !event.includes("message")) return null;
  if (event.includes("update") || event.includes("delete")) return null;
  const data = payload?.data ?? payload;
  const key = data?.key ?? {};
  const chatId = String(key.remoteJid ?? data.remoteJid ?? "");
  if (!chatId || key.fromMe || data.fromMe) return null;
  if (!chatId.endsWith("@s.whatsapp.net")) return null; // ignore groups (@g.us), status@broadcast, newsletters
  const m = data.message ?? {};
  const loc = m.locationMessage;
  const text = String(m.conversation ?? m.extendedTextMessage?.text ?? m.buttonsResponseMessage?.selectedDisplayText ??
    m.listResponseMessage?.singleSelectReply?.selectedRowId ?? data.text ?? "").trim();
  const messageId = String(key.id ?? data.messageId ?? data.id ?? "");
  if (!messageId || (!text && !loc)) return null;
  const ts = Number(data.messageTimestamp ?? 0);
  return {
    messageId, chatId, text, pushName: data.pushName,
    location: loc ? { lat: Number(loc.degreesLatitude), lng: Number(loc.degreesLongitude), address: loc.address || loc.name || undefined } : undefined,
    at: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
  };
}

/** Evolution connection.update events → session health (for QR re-link alerts). */
export function parseConnectionUpdate(payload: any): { state: string; needsQr: boolean } | null {
  if (!String(payload?.event ?? "").toLowerCase().includes("connection")) return null;
  const state = String(payload?.data?.state ?? payload?.data?.status ?? "unknown");
  return { state, needsQr: state === "close" || state === "refused" };
}
