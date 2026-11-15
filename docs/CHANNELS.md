# Channels and the reliable sync core

All messaging (WhatsApp, email, voice, and every future channel) goes through ONE outbound pipeline and ONE inbound pipeline. Adapters only translate to/from a provider; they never touch the database policy (compliance, limits, dedup, status rules).

```
lib/channels/
  types.ts          ChannelAdapter, InboundEvent, OutboundContent, ChannelError, OutboundError
  registry.ts       getAdapter / findAdapter / outboundChannels / supportsOutbound  (ADD NEW ADAPTERS HERE)
  adapters/         whatsapp.ts (whatsapp_cloud), email.ts (resend), voice.ts (vapi)
  outbound.ts       sendOutbound()          the only way to contact a person
  inbound.ts        processInboundEvents()  the only way an inbound event enters the DB
  inbox.ts          ensure*Inbox, resolveInboxByIdentifier, ensureConversation, ensureContactInbox
  conversations.ts  loadThread, backfillLegacyConversations (backfill-on-read), conversationForContact
  usage.ts          reserveUsage / releaseUsage (atomic plan-limit reservation)
  status.ts         applyMessageStatus (monotonic status), CALL_TERMINAL
  voice-events.ts   handleVapiEvent (idempotent call lifecycle)
  campaign-lease.ts campaign run lease (lives in campaigns.stats jsonb)
  errors.ts         toApiError (ComplianceError/OutboundError -> ApiError for legacy callers)
inngest/reconcile.ts  cron: stuck 'queued' -> failed 'unconfirmed'; webhook_events retention (30d)
```

## Outbound: `sendOutbound({orgId, contactId, channel, inboxId?, content, purpose, automated?, campaignId?, idempotencyKey})`

1. Idempotency lookup on `messages.idempotency_key` (stored as `<orgId>:<key>`). A hit returns the existing row (`state: "duplicate"`), nothing is sent.
2. `assertCanContact` (lib/compliance). `ComplianceError` propagates, nothing is recorded.
3. Outbox INSERT (`status=queued`, unique key) BEFORE the provider call. A unique conflict returns the winner's row.
4. Session window: if `adapter.capabilities().hasSessionWindow` and content is not a template and `adapter.sessionWindow(conversation)` is `closed`, the row is marked `failed` (`SESSION_WINDOW_EXPIRED`) and `OutboundError` is thrown. Applies to campaigns, automations and replies alike. Template approval is not checked locally; the provider rejects unapproved templates (definitive failure).
5. `reserveUsage`: one conditional `UPDATE usage SET n = n + 1 WHERE n + 1 <= limit RETURNING`. `PlanLimitError` removes the outbox row so a resume can retry.
6. `adapter.send` once. Only `ChannelError.retryable` (e.g. HTTP 429, not accepted) is retried (max 2). Ambiguous errors are retried only when the adapter declares `idempotentSend`.
7. Outcomes: success -> `sent` + `external_id` (+ legacy `wa_message_id`); definitive failure -> `failed`, usage released, `OutboundError("PROVIDER_REJECTED")` (or the ApiError raised by the adapter); ambiguous (timeout/network/5xx/unexpected) -> stays `queued`, `error = "UNKNOWN"`, result `state: "unknown"`. The reconcile job later marks it `failed: unconfirmed`. It is NEVER re-sent automatically.

Idempotency keys must come from the business operation, not be random: `campaignKey(campaignId, contactId)`, `automationKey(runId, stepId, contactId)`; interactive replies use a client-generated id. The legacy wrappers (`lib/whatsapp` sendMessage/sendTemplate/..., `lib/email` sendEmail, `lib/voice` initiateCall) all call `sendOutbound`; pass `idempotencyKey`, `purpose`, `automated` in their ctx/opts. Without a key they use a random one (no protection against an Inngest step retry).

## Inbound: `processInboundEvents(inbox, events)`

Route: verify signature on the RAW body -> `adapter.parseInbound(raw)` -> group by `event.inboxIdentifier` -> `resolveInboxByIdentifier(channel, identifier)` (the org comes ONLY from the inbox row; unknown identifiers are dropped) -> `processInboundEvents`. Respond 200 only when `failed === 0`, else 500 so the provider retries.

Per event: `claimWebhookEvent` (lib/webhook-dedup; released on failure) -> messages: find/create contact (contact_inboxes, then phone/email, else create), ensure conversation, `INSERT messages` with `@@unique([inbox_id, external_id])` (P2002 = duplicate, ignored), conversation `last_inbound_at/last_message_at/unread_count` updated in the same transaction with GREATEST, reopen if resolved. Side effects only for newly inserted rows: replied_at, `contact/created`, STOP keyword (confirmation reply, then `applyStopKeyword`), `message/inbound` (Inngest event id `message-inbound-<id>`). Status events: `applyMessageStatus` (single conditional UPDATE: queued < sent < delivered < read; `failed` only from queued/sent; never overwrites delivered/read).

## Adding a channel adapter (Telegram, Instagram, Messenger, SMS, webchat, API)

1. Create `lib/channels/adapters/<name>.ts` exporting a `ChannelAdapter`:
   - `channel`, `provider` (matches `inboxes.provider`), `capabilities()` (`supportsOutbound`, `supportsInbound`, `hasSessionWindow`, `idempotentSend`, `usageMetric` or `null`).
   - `sessionWindow(conversation)` pure function of `last_inbound_at`; return `{state:"n/a", outsideWindowRule:"none"}` when there is none.
   - `verifyWebhook({method, headers, rawBody, query})` constant-time, on the raw body; may return a `Response` (GET handshakes).
   - `parseInbound(rawBody)` -> `InboundEvent[]` (`kind: "message"|"status"`, `inboxIdentifier`, `externalId`, `sourceId`, ...). For chat systems whose message id is only unique per chat use `${chatId}:${messageId}`.
   - `send(inbox, msg)` performs exactly ONE provider call and throws `ChannelError` with the right flags: `ambiguous` for timeouts/network/5xx, `retryable` for "not accepted, try later", neither for definitive rejections. Never loop inside `send`.
   - `mapStatus(providerStatus)`.
2. Register it in `lib/channels/registry.ts` (`ADAPTERS`). `supportsOutbound` then makes the channel valid for campaigns (`app/api/campaigns/_lib.ts` validates through the registry).
3. Inbox rows: `inboxes.config` is AES-GCM encrypted JSON (decrypted into `InboxCtx.config`); `identifier` is unique per channel (Telegram bot id, page id, ...); `webhook_token` is for per-inbox URLs. `resolveOutboundInbox` picks the org's first active inbox of the channel when none is given.
4. Webhook route: copy `app/api/webhooks/whatsapp/route.ts` (verify -> parse -> resolve inbox -> `processInboundEvents`). Do not trust org ids in payloads.
5. Metering: set `usageMetric` to an existing metric or add one to `lib/channels/usage.ts` and `plan_limits` (not done for SMS yet).
6. Compliance: `assertCanContact` already takes the channel; update `lib/compliance` for channel-specific opt-outs.
7. Limitations to know: `contacts.phone` is still NOT NULL, so contacts created from channels without a phone get a placeholder `"<channel>:<source_id>"` phone (see `resolveContact`). Make it nullable in a later schema step.

## Campaigns

`campaign-send` claims a run lease inside `campaigns.stats` (`run_id`, `run_heartbeat`) with one conditional UPDATE (the schema has no "claimed" status). Pause/resume clear it. Per-contact idempotency (`campaignKey`) and a per-batch "already messaged" pre-check make resume, step retries and voice re-dials safe. Voice contacts outside the calling window pause the run until the window opens (`step.sleepUntil`). Pacing env: `CAMPAIGN_BATCH_SIZE`, `CAMPAIGN_VOICE_BATCH_SIZE`, `CAMPAIGN_BATCH_INTERVAL_MS`, `CAMPAIGN_SEND_INTERVAL_MS`, `CAMPAIGN_ORG_CONCURRENCY`, `CAMPAIGN_GLOBAL_CONCURRENCY`, `CAMPAIGN_LEASE_TTL_MS`. No provider rate limits are assumed.

## UNVERIFIED items (code is defensive; confirm before relying on them)

- Vapi webhook auth scheme: header name is configurable (`VAPI_WEBHOOK_HEADER`, default `x-vapi-secret`, plus `Authorization: Bearer`); `call.metadata.ai_call_id` echo is used only as a fallback.
- Resend `Idempotency-Key` header is sent but ambiguous retries are off unless `RESEND_IDEMPOTENT_RETRY=1`. Resend inbound/bounce webhook payloads are not wired.
- Meta error codes (outside-window etc.) are not hard-coded; any 4xx is a definitive failure, 429 retryable, 5xx ambiguous.
- Whether a pause-sleeping Inngest run holds a concurrency slot (assumed not; the lease protects correctness either way).

## Channels shipped (workstream N)

All use the shared pipelines (`sendOutbound`, `processInboundEvents`), per-inbox encrypted credentials in `inboxes.config`, and a unique `webhook_token`. Connect/disconnect: `/channels` UI and `app/api/channels` (admin only; disconnect = `is_active=false`). No schema change was needed. None of these were exercised against live provider accounts (no network/DB in the build): treat as untested until smoke-tested. Gaps found: `lib/compliance.assertCanContact` only enforces `wa_opt_out` for whatsapp/sms, so the new adapters call `assertNotOptedOut` inside `send`; `inbound.ts` runs the STOP flow only for whatsapp/sms, so `adapters/_stop.ts` does it for the others.

| Channel | Provider key | Webhook | Auth of webhook | Window |
|---|---|---|---|---|
| Telegram | `telegram_bot` | `POST /api/webhooks/telegram/[token]` | `X-Telegram-Bot-Api-Secret-Token` == per-bot secret (constant-time) | none |
| Messenger / Instagram | `meta_graph` | `GET/POST /api/webhooks/meta` | `X-Hub-Signature-256` with app secret; GET verify token | 24h (blocked after; no templates) |
| SMS | `twilio` | `POST /api/webhooks/sms/[token]` and `/status` | `X-Twilio-Signature` with per-inbox auth token | none |
| Web chat | `webchat` | `POST .../webchat/[token]/message`, `GET .../poll` | unguessable token + per-inbox Origin allow-list + rate limits | none |
| API | `api` | `POST /api/public/v1/messages` | API key (Pro) | none (inbound only) |

### Telegram
- Verified (core.telegram.org/bots/api): `setWebhook` `url`, `secret_token` (1-256 chars `A-Za-z0-9_-`, sent as `X-Telegram-Bot-Api-Secret-Token`), `allowed_updates`; `message_id` unique only per chat; `Chat.id` fits int64. Dedupe key `chat_id:message_id`. We only ingest private chats.
- UNVERIFIED: `sendMessage` 4096-char limit and the error body / 429 `retry_after` shape (page section not read); no delivery receipts exist, messages stay `sent`.
- Flow: paste BotFather token -> `getMe` -> inbox created inactive -> `setWebhook` -> activated. `/stop` and the STOP keywords -> confirmation + `applyStopKeyword`. Env: none (uses `NEXT_PUBLIC_APP_URL`, must be public HTTPS).

### Messenger + Instagram (token-paste flow, no OAuth)
- Verified (developers.facebook.com/docs/messenger-platform/webhooks, /send-messages; instagram-platform messaging-api): GET handshake `hub.mode/verify_token/challenge`; `X-Hub-Signature-256` HMAC-SHA256 with app secret (docs say over the escaped-unicode payload: we try raw then escaped); Messenger `object:"page"`, `entry[].id`=Page id, `messaging[]` fields; Send API `POST /{PAGE_ID}/messages`, `messaging_type` RESPONSE/UPDATE/MESSAGE_TAG, response `message_id`; 24h standard window (7 days after click-to-message ads); HUMAN_AGENT tag = 7 days; Instagram `POST graph.instagram.com/<IG_ID>/messages`, text <= 1000 bytes, permissions `instagram_business_basic` + `instagram_business_manage_messages`.
- UNVERIFIED: Instagram webhook `object:"instagram"` envelope and `is_echo`; Messenger 2000-char limit; Bearer auth header on both hosts; `GET /me?fields=` used for the connect-time token check; Human Agent tag NOT implemented (needs permission; Instagram tag parameter name not in docs read), so only the 24h window is enforced; delivery/read receipts not wired; auto-subscribing the app to the Page (`subscribed_apps`) not done: subscribe manually in the Meta dashboard.
- Env: `META_APP_SECRET` (falls back to `WA_APP_SECRET`), `META_WEBHOOK_VERIFY_TOKEN` (falls back to `WA_WEBHOOK_VERIFY_TOKEN`), `META_GRAPH_VERSION` (falls back to `WA_GRAPH_VERSION`, default v21.0). One app secret per deployment (same limitation as WhatsApp).

### SMS (Twilio only)
- Verified (twilio.com docs: message-resource, webhooks-security, webhook-request): `POST /2010-04-01/Accounts/{sid}/Messages.json` with `To`, `From|MessagingServiceSid`, `Body` (<=1600), `StatusCallback`; statuses list; inbound params `MessageSid, From, To, Body, NumMedia`; status callback `MessageStatus`, `ErrorCode`; signature = HMAC-SHA1(auth token) base64 over the exact configured URL + sorted POST params (JSON bodies use `bodySHA256`, not supported here).
- UNVERIFIED: the exact `key+value` concatenation (docs defer to the SDK), Basic auth on Messages API and the credential check `GET /Accounts/{sid}.json`, `MessageSid` presence in status callbacks, any provider idempotency (none assumed). The webhook URL must equal `NEXT_PUBLIC_APP_URL` + path exactly (proxies/Host are not trusted). India DLT: assumed to be required for commercial SMS but UNVERIFIED and the organisation's responsibility; nothing is checked or claimed. SMS is not metered (`usageMetric: null`). STOP handled by `processInboundEvents`. Campaigns accept `sms` via `outboundChannels()`.
- Env: none (credentials per inbox).

### Web chat
- `public/webchat.js` (vanilla, shadow DOM, `textContent` only, polling 4s open / 20s closed). Visitor id = 128-bit random in localStorage = `contact_inboxes.source_id`; anyone holding it can read that visitor's thread. Optional name/email/phone form fills the contact (never overwrites). Limits: body 8 KB, text 2000 chars, 10 msg/min/visitor, per-IP and per-inbox limits; CORS only for exact origins in the inbox allow-list (missing Origin rejected). Snippet: `<script src="APP/webchat.js" data-token="TOKEN" async></script>`. Agent replies are stored by `sendOutbound`; the adapter makes no network call. No typing indicators, attachments or receipts.

### API channel
- `POST /api/public/v1/messages` `{source_id, content, external_id?, name?, email?, phone?, sent_at?}`: idempotent on `external_id`; creates contact + conversation on the org's `api` inbox. Outbound callbacks are out of scope (`supportsOutbound=false`).

### Notes
- Because the registry now has outbound adapters for telegram/messenger/instagram/webchat, `outboundChannels()` (campaigns) accepts them; contacts without a contact_inbox on that channel fail with `NO_ADDRESS`.
