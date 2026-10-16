# Live push updates and WhatsApp notifications: status (Oct 2026)

## Summary
| Item | Status | Why |
|---|---|---|
| Live push updates (local runtime) | **Blocked: needs an owner design decision** | Building it means adding a new authorization surface (a push channel from Electron main into the renderer). Census rules say that needs owner sign-off first. |
| WhatsApp notifications | **Blocked: needs owner accounts/approval** | The only working integration is the unofficial Evolution API gateway (it drives WhatsApp Web). The official route, Meta's WhatsApp Cloud API, needs a Meta Business account, a verified number, approved message templates and an access token. Only the owner can get these. |

## What exists today
- `src/contexts/WhatsAppNotifsContext.tsx` and other screens call `supabase.channel(...).on("postgres_changes", ...)`. On the hosted Supabase stack that is Realtime. On the **local runtime** `src/backend/local-client.ts` returns a no-op channel, so nothing is pushed. Screens fall back to React Query refetch-on-focus/interval.
- `local-service/src/events/outbox.rs` keeps an in-memory, per-tenant/branch event outbox with cursors. It is not exposed over HTTP, and mutations do not append to it yet.
- `electron/services/local-runtime.ts` `subscribe()` throws `LOCAL_RUNTIME_NOT_CONFIGURED`. The `LOCAL_SUBSCRIBE` IPC handler exists but cannot be used.
- `supabase/functions/send-whatsapp-message` and `evolution-webhook` talk to Evolution API (`EVOLUTION_API_URL` / `EVOLUTION_API_KEY`). That is the unofficial gateway we were told not to depend on.

## Proposed plan once approved
### Live push (about 1–2 days)
1. Local service: write the outbox to Postgres (`LISTEN/NOTIFY` on commit of sales, table orders, KDS tickets, inventory). Add an authenticated `GET /v1/events?cursor=` long-poll/SSE endpoint, filtered by the caller's tenant/branch membership.
2. Electron main: one long-lived stream per signed-in session. Forward events to the trusted window through a single `webContents.send('local-event', {kind, sequence})`. **New census surface:** one ipc-renderer `on` listener in preload. The payload carries no row data, only the kind and cursor.
3. Renderer: `local-client.channel()` maps `postgres_changes` subscriptions to those kinds and invalidates the matching React Query keys. Data is still read through the normal authorized endpoints.

### WhatsApp (official Cloud API)
1. Owner: create a Meta Business account and a WhatsApp Business number, approve templates (order ready, receipt, delivery update), and issue a system-user token.
2. Add a `whatsapp-cloud` sender behind the existing `send-whatsapp-message` interface, configured with `WHATSAPP_CLOUD_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`. Remove the Evolution dependency.
3. Inbound messages: a Meta webhook (signature-verified with the app secret) replaces `evolution-webhook`.

Nothing in this branch sends WhatsApp messages or opens a push channel.
