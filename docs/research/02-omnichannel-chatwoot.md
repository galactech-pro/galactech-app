# 02 - Omnichannel design: Chatwoot patterns and a proposal for OmniReach

Date: 2026-11-14. Scope: research only, no code edited. Sources are cited inline. "UNVERIFIED" marks facts I could not confirm from official docs in this session.

Not covered: Papercups, Typebot, Twenty, Rocket.Chat, Mautic and Postal were NOT read in this pass; only Chatwoot was studied in depth. Treat any claim about them as absent.

---

## 1. What Chatwoot does (from source)

Base: https://github.com/chatwoot/chatwoot (branch `develop`). Raw files: `https://raw.githubusercontent.com/chatwoot/chatwoot/develop/<path>`.

### 1.1 Entity model (db/schema.rb)
https://raw.githubusercontent.com/chatwoot/chatwoot/develop/db/schema.rb

- **Account -> Inbox -> Channel (polymorphic).** `inboxes` has `channel_id` + `channel_type` (e.g. `Channel::Whatsapp`), `account_id`, `name`, plus *behaviour* settings: `enable_auto_assignment`, `greeting_*`, `working_hours_enabled`, `timezone`, `csat_survey_enabled`, `allow_messages_after_resolved`, `lock_to_single_conversation`, `auto_assignment_config` jsonb. There is no unique index on inboxes.
- **Each channel type is its own table** holding credentials and provider config:
  - `channel_whatsapp`: `phone_number` (unique), `provider` ("default" = 360dialog, or "whatsapp_cloud"), `provider_config` jsonb, `message_templates` jsonb, health fields.
  - `channel_email`: `email` (unique), `forward_to_email` (unique), full IMAP and SMTP settings, `provider`, `provider_config`.
  - `channel_api`: `webhook_url`, `identifier` (unique), `hmac_token` (unique), `hmac_mandatory`.
  - `channel_telegram`: `bot_token` (unique). `channel_line`: `line_channel_id` (unique) + secret + token.
  - `channel_sms`: `phone_number` (unique), `provider`, `provider_config`. `channel_twilio_sms`: `account_sid`, `auth_token`, `medium` (sms or whatsapp), `messaging_service_sid`.
  - `channel_facebook_pages`: `page_id`, `page_access_token`, `instagram_id`. unique (page_id, account_id).
  - `channel_web_widgets`: `website_token` (unique), `hmac_token`, pre-chat form, `allowed_domains`.
- **Contact vs ContactInbox.** `contact_inboxes`: `contact_id`, `inbox_id`, `source_id` (text, not null), `hmac_verified`, `pubsub_token`. **Unique (inbox_id, source_id).** `source_id` is "the contact's address inside that channel" (WhatsApp wa_id/phone, Telegram chat id, Twilio number, widget visitor id). Validation is per channel (`app/models/contact_inbox.rb`: regex for WhatsApp and Twilio, presence only otherwise). Source: https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/models/contact_inbox.rb
- **Conversation:** `account_id`, `inbox_id`, `contact_id`, `contact_inbox_id`, `status` (open/resolved/pending/snoozed as integer), `assignee_id`, `team_id`, `display_id` (per-account sequence, unique with account_id), `last_activity_at`, `waiting_since`, `first_reply_created_at`, `snoozed_until`, `priority`, `sla_policy_id`, `additional_attributes`/`custom_attributes` jsonb, `cached_label_list`, `assignee_agent_bot_id`, `campaign_id`.
- **Message:** `conversation_id`, `inbox_id`, `message_type` int (incoming 0, outgoing 1, activity 2, template 3), `status` int (sent 0, delivered 1, read 2, failed 3), `content`, `content_type` (text, input_*, cards, form, article, incoming_email, input_csat, integrations, sticker, voice_call...), `content_attributes` json, `source_id` text (the provider message id), `private` bool (internal notes), `sender_type`/`sender_id` polymorphic, `external_source_ids` jsonb (in practice only a Slack accessor), `additional_attributes`. **No unique index on messages.source_id**; dedup is done in service code (see 1.3). Source: https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/models/message.rb
- **Attachments:** separate table (`file_type`, `external_url`, `extension`, `meta`, coordinates), `message_id` FK.
- **Ops objects:** `teams`, `labels` (unique per title+account), `canned_responses` (`short_code`, `content`), `macros` (`actions` jsonb, visibility), `automation_rules` (`event_name`, `conditions` jsonb, `actions` jsonb, `execution_delay`), `agent_bots` (`outgoing_url`, `secret`), `sla_policies` (first_response, next_response, resolution thresholds, business-hours flag), `csat_survey_responses` (rating, feedback, one per message_id, assigned_agent_id), `webhooks` (`url`, `subscriptions` jsonb event list, `secret`, optional `inbox_id`, unique (account_id,url)).

### 1.2 Provider abstraction for WhatsApp
- `app/models/channel/whatsapp.rb`: `PROVIDERS = default|whatsapp_cloud`; `provider_service` picks `Whatsapp::Providers::WhatsappCloudService` or `Whatsapp360DialogService`, and `send_message`, `send_template`, `sync_templates`, `media_url`, `api_headers` are delegated to it. Validates credentials on save; sets `webhook_verify_token` for cloud; encrypts only the business_management_token (and only if encryption is configured). https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/models/channel/whatsapp.rb
- Provider interface (`app/services/whatsapp/providers/base_service.rb`) is just five abstract methods: `send_message(phone, message)`, `send_template(phone, template_info, message)`, `sync_template`, `validate_provider_config`, `error_message(response)`. https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/services/whatsapp/providers/base_service.rb
- Twilio WhatsApp is a *different channel* (`Channel::TwilioSms` with medium=whatsapp), not a provider of Channel::Whatsapp. Lesson: the same network (WhatsApp) can appear under two channel types; Chatwoot did not unify them.
- Chatwoot's 24h window logic is NOT in the channel model; it lives in the frontend/other services (I did not locate it, UNVERIFIED location).

### 1.3 Inbound pipeline and dedup
`app/services/whatsapp/incoming_message_base_service.rb` https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/services/whatsapp/incoming_message_base_service.rb

1. Webhook controller hands payload to a job, then service `perform`.
2. If payload has `statuses` -> `process_statuses` only.
3. Else for each message: skip unsupported types; `find_message_by_source_id` returns early if exists; `lock_message_source_id!` is a Redis `SET NX` lock so two workers cannot race; resolve/create contact and ContactInbox; **inside one DB transaction** `set_conversation` + `create_messages`.
4. Conversation reuse: last non-resolved conversation for the contact_inbox (or the last one if `lock_to_single_conversation`), else create.
5. Unsupported content becomes a placeholder message with `is_unsupported` flag so the thread is not silently lossy. Media is downloaded and attached. Business-app echoes (coexistence) are stored as outgoing with status `delivered` so the send job does not resend.
6. Status updates: find message by `source_id`, call `Messages::StatusUpdateService`.

`Messages::StatusUpdateService` https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/services/messages/status_update_service.rb : runs inside `message.with_lock`; allows transition if new==failed, or current==failed, or priority(new) >= priority(current) (nil = -1); sets `external_error`, clears it on non-failed. This is a monotonic state machine that tolerates out-of-order callbacks.

### 1.4 Outbound
`app/jobs/send_reply_job.rb` has a `CHANNEL_SERVICES` map channel class -> `Send<X>Service` (Twilio, Line, Telegram, Whatsapp, Sms, Instagram, Email, Tiktok; WebWidget and Api just email-notify; FacebookPage handled specially and branches Instagram DM vs Messenger via `conversation.additional_attributes['type']`). https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/jobs/send_reply_job.rb
Message `after_create_commit` dispatches `MESSAGE_CREATED`, `FIRST_REPLY_CREATED`/`REPLY_CREATED`, enqueues `SendReplyJob`, reopens resolved conversations. It also has `prevent_message_flooding` (per-minute cap) to stop automation loops.

### 1.5 Events and webhooks
- Internal event dispatcher + listeners. `app/listeners/webhook_listener.rb` handles `conversation_created`, `conversation_updated`, `conversation_status_changed`, `message_created`, `message_updated`, `webwidget_triggered`, `conversation_typing_on/off` (inbox+account), and `contact_created/updated`, `inbox_created/updated` (account only). For each subscribed webhook it enqueues `WebhookJob` with url, payload, webhook type (account / api-inbox / agent-bot), `secret` and a fresh UUID `delivery_id`. https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/listeners/webhook_listener.rb
- `WebhookJob` is a thin wrapper to `Webhooks::Trigger`; I did not read signing/retry code (UNVERIFIED). https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/jobs/webhook_job.rb
- Payload comes from `Message#webhook_data`: account, conversation, inbox, sender, attachments.

### 1.6 Automation, macros, SLA, CSAT, bots
- Automation = rules keyed on event name with jsonb conditions/actions (assign, label, send message, etc.), optional delay. Macros = same actions executed manually by an agent.
- SLA = per-policy thresholds applied to a conversation (`sla_policy_id`), tracked via `waiting_since` and `first_reply_created_at`.
- CSAT = a message of content_type `input_csat` on resolve, response row unique per message.
- Agent bots = HTTP outgoing_url receiving events; bot can be `assignee_agent_bot_id` on a conversation, hands off to humans by changing status.

### 1.7 Not read
Reporting module, teams/assignment services (round robin), canned-response UI, Papercups/Typebot/Twenty/Rocket.Chat/Mautic/Postal. Pointers only: Chatwoot reporting = SQL over conversations/messages with `first_response_time`, `resolution_time` events; implement analogous aggregates directly in SQL.

---

## 2. Verified external API facts (used by the adapters)

| Fact | Status | Source |
|---|---|---|
| WhatsApp Cloud send: `POST https://graph.facebook.com/<ver>/<PHONE_NUMBER_ID>/messages`; response id at `messages[0].id` (`wamid...`); only confirms acceptance, delivery comes by webhook. Doc example uses v27.0. | VERIFIED | developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages |
| 24h customer service window opens when user messages/calls, resets on each new user message; outside it only pre-approved templates. | VERIFIED | same |
| Error code for out-of-window send (commonly 131047) | UNVERIFIED (page does not mention it) | |
| Webhook payload shape: `object: whatsapp_business_account`, `entry[].changes[].value` with `metadata.phone_number_id`, `contacts[]`, `messages[]` (`from`, `id`, `timestamp`, `type`). Statuses ride the same `messages` field. Newer docs add business-scoped user IDs (`user_id`/`from_user_id`) and say `wa_id`/`from` may be omitted. | VERIFIED (shape); status object fields UNVERIFIED here | developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks |
| WhatsApp webhook retries on non-200 for up to 7 days at decreasing frequency; duplicates possible; payload up to 3 MB. | VERIFIED | same |
| Generic Graph webhooks (Page/IG): verify with GET `hub.mode=subscribe`, `hub.verify_token`, echo `hub.challenge`; events carry `X-Hub-Signature-256: sha256=<sig>` computed with the App Secret (HMAC-SHA256 is the standard method; doc doesn't use the word HMAC); retried for up to 36 hours; batches up to 1000; respond 200. | VERIFIED (HMAC wording inferred) | developers.facebook.com/docs/graph-api/webhooks/getting-started |
| Messenger send: `POST https://graph.facebook.com/v27.0/{PAGE-ID}/messages` with Page token; `messaging_type` RESPONSE / UPDATES / tagged; standard window 24h (7 days after click-to-Messenger ad first message); HUMAN_AGENT tag gives 7 days; response `recipient_id` (PSID), `message_id`. Several tags (CONFIRMED_EVENT_UPDATE, ACCOUNT_UPDATE, POST_PURCHASE_UPDATE) return error 100 from 2026-04-27. | VERIFIED | developers.facebook.com/docs/messenger-platform/send-messages |
| Instagram DM send: `POST https://graph.instagram.com/v27.0/<IG_ID>/messages` (or /me/messages) with `recipient` (IGSID) and `message`; 24h window, 7 days with HUMAN_AGENT; permissions `instagram_business_basic` + `instagram_business_manage_messages`; Advanced Access needed for accounts you do not own/manage; webhook fields `messages`, `messaging_optins`, `messaging_postbacks`, `messaging_reactions`, `messaging_referrals`, `messaging_seen`. | VERIFIED | developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api |
| Telegram `setWebhook`: `url` (HTTPS), `secret_token` 1-256 chars `[A-Za-z0-9_-]`, `allowed_updates`, `max_connections` 1-100 (default 40), `drop_pending_updates`. Header on each request: `X-Telegram-Bot-Api-Secret-Token`. `update_id` is a sequential integer (resets to random after a week of silence). `message_id` is unique only **within a chat** -> dedup key must be `chat_id:message_id` (or update_id). | VERIFIED | core.telegram.org/bots/api |
| Telegram rate limits and getFile size limit | UNVERIFIED (not in the portion read; commonly cited 20 MB download, ~30 msg/s overall, 1 msg/s per chat) | |
| Twilio status callbacks: pass `StatusCallback` per message (or service-level with a Messaging Service); `MessageStatus` e.g. queued, sent, delivered, undelivered, failed (and `read` via EventType for WhatsApp/RCS); `ErrorCode` on failed/undelivered; **callbacks may arrive out of order**. | VERIFIED | twilio.com/docs/messaging/guides/track-outbound-message-status |
| Twilio signature: `X-Twilio-Signature`, HMAC-SHA1 keyed with auth token over full URL + alphabetically sorted POST params; JSON bodies add `bodySHA256` query param; use SDK validator. | VERIFIED | twilio.com/docs/usage/webhooks/webhooks-security |
| Resend inbound: MX on verified domain, Resend parses and POSTs to your webhook; body/attachments fetched through API (attachments as temporary download URLs). Webhook verification via Svix headers `svix-id`, `svix-timestamp`, `svix-signature` with raw body (`resend.webhooks.verify()`). Exact event name (`email.received`) and payload fields | event name UNVERIFIED | resend.com/docs/dashboard/receiving/introduction ; resend.com/docs/webhooks/verify-webhooks-requests |
| Vapi server messages: `status-update` (scheduled, queued, ringing, in-progress, forwarding, ended), `end-of-call-report`, `transcript`, `conversation-update`, `hang`, etc.; most carry `message.call`. Call id property name and server-URL auth scheme | UNVERIFIED (current schema already stores `vapi_call_id`; check docs.vapi.ai/server-url/setting-server-urls) | docs.vapi.ai/server-url/events |
| India SMS DLT: entity registration -> header (sender ID) -> template registration; template ID must accompany each send; messages without registered entity/approved header are blocked; separate template categories (transactional/promotional/service). | VERIFIED via vendor docs only (Plivo, Exotel, WebEngage, EnableX), not TRAI primary | search results; recheck with the SMS vendor you choose |
| MSG91 and Gupshup API request shapes | UNVERIFIED (MSG91 DLT page 404) | |
| IMAP IDLE/polling details for email | not researched; prefer inbound webhook | |

---

## 3. Proposal for OmniReach

Current state (prisma/schema.prisma): `channel` enum {whatsapp,email,voice,sms}; `contacts` unique (org_id, phone), phone required; `messages` keyed to `contact_id + channel` with `direction`, `status` (queued/sent/delivered/read/failed), `wa_message_id` (indexed, NOT unique), `campaign_id`, engagement timestamps; credentials live on `organisations` (`wa_*`, `resend_api_key`, AES-256-GCM via `apps/web/lib/crypto.ts`); `integrations` already has the encrypted-config pattern; `ai_calls` stores Vapi calls separately with `vapi_call_id` unique.

### 3.1 (a) Prisma extension

Design rules: solo-dev sized. One `inboxes` table with `type` + encrypted JSON `config` (not one table per channel). Unique constraints do the dedup (no Redis lock). org_id on every table (code-enforced scoping, per existing convention).

```prisma
enum channel {            // extend existing
  whatsapp
  email
  voice
  sms
  instagram
  messenger
  telegram
  webchat
  api
}

enum conversation_status { open pending snoozed resolved }
enum message_kind        { message note activity }          // note = internal private note
enum message_content_type { text image video audio document location template interactive reaction unsupported }

model inboxes {
  id           String   @id @default(uuid()) @db.Uuid
  org_id       String   @db.Uuid
  name         String
  channel      channel
  provider     String   @default("default")   // whatsapp: cloud|360dialog|twilio ; sms: twilio|msg91|gupshup ; email: resend
  identifier   String                         // phone_number_id | email addr | IG/page id | bot id | widget token | to-number
  config       String                         // AES-256-GCM JSON: tokens, app secret, verify token, webhook secret, DLT entity/header ids
  webhook_token String  @unique @default(uuid()) // goes in /api/webhooks/{channel}/{webhook_token}; routes inbound to org+inbox
  is_active    Boolean  @default(true)
  settings     Json     @default("{}")        // greeting, business hours, auto-assign, csat on/off
  created_at   DateTime @default(now())
  updated_at   DateTime @updatedAt

  org           organisations   @relation(fields: [org_id], references: [id], onDelete: Cascade)
  contact_inboxes contact_inboxes[]
  conversations conversations[]
  messages      messages[]

  @@unique([channel, identifier])             // one provider account cannot be connected twice (cf. Chatwoot unique phone_number)
  @@index([org_id])
}

model contact_inboxes {                       // Chatwoot ContactInbox
  id         String   @id @default(uuid()) @db.Uuid
  org_id     String   @db.Uuid
  contact_id String   @db.Uuid
  inbox_id   String   @db.Uuid
  source_id  String                           // wa_id/phone, Telegram chat_id, IGSID, PSID, email address, widget visitor id
  meta       Json     @default("{}")          // profile name, username, bsuid
  last_inbound_at DateTime?                   // drives session window
  created_at DateTime @default(now())

  contact contacts @relation(fields: [contact_id], references: [id], onDelete: Cascade)
  inbox   inboxes  @relation(fields: [inbox_id], references: [id], onDelete: Cascade)

  @@unique([inbox_id, source_id])
  @@index([contact_id])
}

model conversations {
  id               String              @id @default(uuid()) @db.Uuid
  org_id           String              @db.Uuid
  inbox_id         String              @db.Uuid
  contact_id       String              @db.Uuid
  contact_inbox_id String              @db.Uuid
  status           conversation_status @default(open)
  assignee_id      String?             @db.Uuid     // users.id
  labels           String[]            @default([]) // reuse the tags approach; no label table yet
  last_message_at  DateTime            @default(now())
  first_reply_at   DateTime?
  waiting_since    DateTime?                       // set on inbound, cleared on agent reply; feeds SLA
  snoozed_until    DateTime?
  bot_active       Boolean             @default(false) // AI agent handling; human takeover flips false
  meta             Json                @default("{}")
  created_at       DateTime            @default(now())

  @@index([org_id, status, last_message_at])
  @@index([contact_inbox_id, status])
}

model messages {                              // MODIFIED, see 3.3
  id               String   @id @default(uuid()) @db.Uuid
  org_id           String   @db.Uuid
  conversation_id  String?  @db.Uuid          // nullable during backfill, then NOT NULL
  inbox_id         String?  @db.Uuid
  contact_id       String   @db.Uuid          // keep: cheap contact timeline
  campaign_id      String?  @db.Uuid
  channel          channel                    // keep (denormalised, existing queries)
  direction        message_direction
  kind             message_kind @default(message)
  content_type     message_content_type @default(text)
  content          String
  content_attributes Json   @default("{}")    // template name/vars, buttons, reply_to_external_id, subject, in_reply_to, is_unsupported
  attachments      Json     @default("[]")    // [{type,url,mime,size,provider_media_id}] ; move to table only if you need querying
  status           message_status @default(queued)
  external_id      String?                    // provider message id: wamid / Twilio SID / Resend id / "chat_id:msg_id"
  error_code       String?
  error            String?
  sender_user_id   String?  @db.Uuid          // agent; null = contact or system/AI
  sender_kind      String   @default("contact") // contact | agent | ai | system
  // existing opened_at, clicked_at, replied_at, sent_at, created_at stay
  @@unique([inbox_id, external_id])           // idempotent inbound AND status lookup (NULLs allowed multiple in Postgres)
  @@index([conversation_id, created_at])
}
```

Notes:
- Postgres treats NULLs as distinct in unique indexes, so unsent outbound rows (external_id null) do not collide.
- Status enum: extend with `received`? Not needed; inbound messages are created as `delivered` (Chatwoot echo precedent). Add `undelivered` only if using Twilio (map to `failed`). Keep enum as is.
- Defer to later (not needed to ship): teams, canned_responses, macros, sla_policies, csat table, agent_bots table. Use jsonb in `inboxes.settings`, `organisations`-level `canned_responses` table only when the inbox UI exists.

State machine (copy Chatwoot's `StatusUpdateService` semantics):
`queued(0) < sent(1) < delivered(2) < read(3)`; `failed` allowed from anything; leaving `failed` allowed; ignore lower-priority updates (out-of-order callbacks are explicitly possible for Twilio, and Meta retries produce duplicates). Implement as a single SQL `UPDATE ... WHERE id=$1 AND rank(status) <= rank($new)` or `SELECT ... FOR UPDATE` in a transaction. No Redis.

Conversation resolution rule (copy Chatwoot): inbound -> find latest non-resolved conversation for `contact_inbox_id`, else create. Email additionally threads by `In-Reply-To`/`References` header stored in `content_attributes`.

Inbound idempotency recipe (replaces Redis `SET NX`):
```
INSERT message ... ON CONFLICT (inbox_id, external_id) DO NOTHING RETURNING id
-- no row returned => duplicate, ack 200 and stop
```
Run contact_inbox upsert + conversation find/create + message insert in one `prisma.$transaction`. Return 200 to Meta fast, do heavy work (media download, AI reply, automations) in Inngest, with the Inngest event id set to `${inbox_id}:${external_id}` for a second layer of dedup.

### 3.2 (b) ChannelAdapter interface

```ts
export type ChannelKind = 'whatsapp'|'email'|'sms'|'voice'|'instagram'|'messenger'|'telegram'|'webchat'|'api';
export type MessageStatus = 'queued'|'sent'|'delivered'|'read'|'failed';

export interface InboundEvent {                       // normalised
  kind: 'message' | 'status';
  // message
  sourceId?: string;            // contact address in channel -> contact_inboxes.source_id
  contactName?: string;
  externalId: string;           // dedup key (message id, or for status: id of the message being updated)
  contentType?: string; content?: string;
  attachments?: { type: string; url?: string; providerMediaId?: string; mime?: string }[];
  replyToExternalId?: string;
  sentAt?: Date;
  raw?: unknown;
  // status
  status?: MessageStatus; errorCode?: string; error?: string;
}

export interface Capabilities {
  text: boolean; media: ('image'|'video'|'audio'|'document')[]; templates: boolean;
  interactive: boolean; reactions: boolean; threading: boolean; readReceipts: boolean;
  maxTextLength?: number; requiresTemplateOutsideWindow: boolean;
}

export interface SessionWindow {                       // pure function of last inbound time
  state: 'open' | 'closed' | 'n/a';
  closesAt?: Date;
  outsideWindowRule: 'template_only' | 'human_agent_tag' | 'none' | 'blocked';
}

export interface SendInput {
  to: string;                                          // contact_inboxes.source_id
  content: string; contentType: string;
  attachments?: Attachment[];
  template?: { name: string; language: string; variables?: string[]; dltTemplateId?: string };
  replyToExternalId?: string;
  idempotencyKey: string;                              // our messages.id
  statusCallbackUrl?: string;                          // Twilio StatusCallback
}
export interface SendResult { externalId: string; status: 'sent'|'queued'; raw?: unknown }

export interface ChannelAdapter<Cfg = unknown> {
  readonly channel: ChannelKind;
  readonly provider: string;
  capabilities(cfg: Cfg): Capabilities;
  sessionWindow(lastInboundAt: Date | null, now: Date, cfg: Cfg): SessionWindow;
  verifyWebhook(req: { method: string; url: string; headers: Headers; rawBody: string; query: URLSearchParams }, cfg: Cfg):
      { ok: true; response?: Response } | { ok: false };   // handles GET handshake (Meta hub.challenge) too
  parseInbound(rawBody: string, cfg: Cfg): InboundEvent[];  // a Meta POST may carry many entries
  send(input: SendInput, cfg: Cfg): Promise<SendResult>;    // throws ChannelError{retryable, code}
  mapStatus(providerStatus: string, providerError?: unknown): { status: MessageStatus; errorCode?: string };
  validateConfig?(cfg: Cfg): Promise<void>;
  setupWebhook?(cfg: Cfg, url: string): Promise<void>;     // Telegram setWebhook, Meta subscribe
}
```
Registry: `const adapters: Record<`${channel}:${provider}`, ChannelAdapter>`; route handler `/api/webhooks/[channel]/[token]` looks up `inboxes.webhook_token`, decrypts config, calls `verifyWebhook` (always on the RAW body: Resend/Svix and Meta both sign raw bytes), `parseInbound`, then a single shared `ingest(inbox, events)` that does the dedup/transaction in 3.1. Outbound: shared `sendMessage(messageId)` Inngest function loads the message+inbox, enforces `sessionWindow`, calls `adapter.send`, writes `external_id`, retries only on `retryable`. This mirrors Chatwoot's `SendReplyJob` map without the Rails class zoo.

Adapters, in priority order, with facts to encode:

1. **whatsapp:cloud** (Priority 1). send POST `/{phone_number_id}/messages`; externalId = `messages[0].id`; verifyWebhook = GET handshake `hub.mode/verify_token/challenge` + POST `X-Hub-Signature-256` HMAC-SHA256 with app secret over raw body; parseInbound walks `entry[].changes[].value`, `messages[]` -> message events, statuses -> status events (sent/delivered/read/failed; field names UNVERIFIED here, confirm in Meta messages reference); window = 24h from last inbound, outside -> template only. Tolerate missing `wa_id` (newer docs say it may be omitted, use `user_id` fallback; store in `contact_inboxes.meta`). Other providers (360dialog, Twilio WA) = later adapters of the same interface, `provider` column on inbox. Do not build until a customer needs them.
2. **email:resend** outbound + Resend inbound webhook (MX on a subdomain, e.g. `reply.<domain>`). verifyWebhook = Svix headers on raw body. externalId = Resend email id; thread using Message-ID/In-Reply-To in `content_attributes`; no session window. Inbound event name/payload: UNVERIFIED, read create-receiving-webhook doc before coding. IMAP polling = skip (Chatwoot ships full IMAP+SMTP columns; for a solo dev that is a large maintenance surface). Add only on demand, via Inngest cron.
3. **sms:twilio / msg91 / gupshup**. Twilio: pass `StatusCallback`, verify `X-Twilio-Signature` (use official SDK `validateRequest`), mapStatus queued/sent/delivered/undelivered/failed with ErrorCode, tolerate out-of-order. India: every send needs DLT-approved template + entity + header; store `dltTemplateId`, `dltEntityId`, `senderId` in inbox config and template record; adapter refuses free-form SMS (`requiresTemplateOutsideWindow` = true always). MSG91/Gupshup request formats UNVERIFIED. No session window.
4. **voice:vapi**. Treat a call as one conversation message of `content_type` `voice_call` (Chatwoot has the same content type) whose `content_attributes` hold summary/transcript/recording; keep `ai_calls` as the detail table and link via `messages.external_id = vapi_call_id`. Webhook types `status-update`, `end-of-call-report` verified; auth scheme and call-id field UNVERIFIED. Outbound = create call (campaign/automation), not a chat send.
5. **instagram + messenger (Meta Graph)**. Separate inbox types but one shared Meta webhook verifier. Send to `graph.instagram.com/v27.0/{IG_ID}/messages` (IG login flow) or `graph.facebook.com/v27.0/{PAGE_ID}/messages`. Window 24h, HUMAN_AGENT tag extends to 7 days. Needs `instagram_business_manage_messages` and app review/Advanced Access for accounts you do not own, which is a real gating cost for agency-style customers. Use `source_id` = IGSID or PSID. Chatwoot distinguishes them with a conversation `additional_attributes.type`; we use inbox.channel instead.
6. **telegram**. `setWebhook` with `secret_token`; verify `X-Telegram-Bot-Api-Secret-Token` (constant-time compare); externalId = `${chat_id}:${message_id}` because message_id is only unique per chat. No window. Easy, good first test of the abstraction.
7. **webchat widget**. Own token + `allowed_domains`; visitor id = source_id; realtime via Supabase Realtime or SSE; optional HMAC identity verification like Chatwoot's `hmac_token`. Largest UI cost; build after API channel.
8. **api (generic)**. Per-inbox `webhook_url` + HMAC secret for outbound events, `POST /api/v1/inboxes/{id}/messages` inbound with the existing `api_keys`. This one unlocks everything else (Typeform, custom apps) cheaply; build early.

### 3.3 (c) Migration path from current schema

Order matters; every step is backward compatible until step 6.

1. `ALTER TYPE channel ADD VALUE` for instagram, messenger, telegram, webchat, api. (Enum additions are not transactional with use in the same migration in Postgres; run as its own migration.)
2. Create new tables: `inboxes`, `contact_inboxes`, `conversations`; new enums.
3. Add nullable columns to `messages`: `conversation_id`, `inbox_id`, `kind`, `content_type`, `content_attributes`, `attachments`, `external_id`, `error_code`, `sender_user_id`, `sender_kind`.
4. Data backfill (script/Inngest one-off):
   - For each org with `wa_phone_number_id` -> insert `inboxes` (channel whatsapp, provider cloud, identifier = phone_number_id, `config` = re-wrap existing already-encrypted `wa_access_token` + business_account_id into the JSON config and encrypt once, or store `{token_enc}` as is). For `resend_api_key` -> email inbox; sms/voice inboxes similarly (voice identifier = org's Vapi number/assistant). Note `@@unique([channel, identifier])` will fail for orgs sharing a number: check duplicates first.
   - For each distinct (contact_id, channel) in `messages` -> `contact_inboxes` with `source_id` = contacts.phone (whatsapp/sms/voice) or contacts.email (email). Contacts with email-only identity cannot exist today (phone required); that constraint relaxes below.
   - For each contact_inbox -> one `conversations` row, status `resolved` if last message older than N days else `open` (policy choice), `last_message_at` = max(created_at).
   - `UPDATE messages SET conversation_id, inbox_id`, `external_id = wa_message_id`, `sender_kind` = contact for inbound / agent-or-system for outbound (campaign_id not null -> system), `content_type='text'`.
   - Duplicates in `wa_message_id` (it is not unique today) must be deduped before the unique index: find with `GROUP BY inbox_id, wa_message_id HAVING count>1`.
5. Add `@@unique([inbox_id, external_id])` and `@@index([conversation_id, created_at])`; make `conversation_id`, `inbox_id` NOT NULL.
6. Switch code: WhatsApp webhook handler writes through `ingest()`; send path uses adapter; read `external_id` not `wa_message_id`. After a release of soak, drop `wa_message_id` (and its index) and `organisations.wa_phone_number_id/wa_access_token/wa_business_account_id/resend_api_key` (move to inbox config; keep until all code reads inboxes). Update `lib/api.ts` org scoping: every inbox/conversation query filters org_id.
7. `contacts`: relax `phone String` to nullable and change `@@unique([org_id, phone])` to partial unique indexes (phone, email) since Instagram/Telegram/webchat contacts have no phone. Identity then lives in `contact_inboxes`; `contacts.phone` becomes "primary phone" convenience. Add an identity-merge helper (match by phone/email) rather than auto-merge across channels.
8. Rewire: campaigns send via inbox (`campaigns.inbox_id` new nullable FK; old `channel` retained for filtering); `usage` counters stay per channel; `automation_trigger.campaign_reply` -> fire from `ingest()`; `ai_calls` keeps as is, plus a message row per call.

What changes, exactly: new tables inboxes/contact_inboxes/conversations; messages gains 10 columns + unique index, loses `wa_message_id`; organisations loses 4 credential columns; contacts.phone nullable; channel enum +5 values; campaigns +inbox_id; new route `/api/webhooks/[channel]/[token]`; new Inngest functions `message/send` and `inbound/process`.

### 3.4 (d) What NOT to copy

- **Polymorphic channel tables** (`Channel::*` per type, STI via `channel_type`). One `inboxes` row with typed-and-validated (zod) encrypted JSON config is enough; Prisma has no polymorphic relations anyway.
- **Rails event dispatcher + listeners + ActiveJob queue taxonomy.** Use Inngest events; emit just `message.received`, `message.status_changed`, `conversation.status_changed`, `conversation.assigned`.
- **Redis SET NX lock for dedup.** A Postgres unique constraint with ON CONFLICT is simpler and durable.
- **Integer enums in DB** (message_type 0..3, status ints). Use Postgres enums as you do now.
- **`display_id` per-account sequence, `cached_label_list`, `uuid` columns, pubsub_token.** Use uuid ids; labels as string[] until needed.
- **Separate tables for teams, macros, canned responses, SLA policies, CSAT responses, agent bots, automation_rules** up front. You already have `automations` (React Flow graph) which supersedes Chatwoot's rule/macro engine; add `teams` and `canned_responses` only when the inbox UI needs them; SLA = two columns (`waiting_since`, `first_reply_at`) plus a report query; CSAT = a template message + one `Json` field; agent bot = your AI agent (`conversations.bot_active`), not an HTTP bot protocol.
- **Full IMAP/SMTP per-inbox setup, OAuth providers for Google/Microsoft email** (`channel_email` has ~20 columns). Resend outbound + inbound webhook first.
- **Multiple WhatsApp providers on day one** (360dialog, Twilio WA). Keep the `provider` field and the interface; ship Cloud only. Chatwoot itself modelled Twilio WA as a different channel, a sign this is messy.
- **Template sync stored as jsonb on the channel.** Keep a `message_templates` table only when campaigns need approval status tracking (also required for DLT template ids).
- **Reaching for Twilio/Chatwoot's webhook retry design.** Meta already retries for 7 days (WhatsApp) / 36 hours (Graph); your job is just idempotency and a fast 200.
- **Account-level + inbox-level + bot-level outgoing webhook matrix.** Single `webhook_endpoints` (org, url, secret, events[]) when you ship the public API; sign with HMAC-SHA256 and include a delivery id (Chatwoot does send a UUID delivery_id and secret; exact signing scheme UNVERIFIED).

### 3.5 Suggested build order
1. Steps 1-5 of migration + `ingest()` + WhatsApp Cloud adapter (replace current handler). 2. Status state machine + session window enforcement in `send`. 3. Email (Resend in/out) + API channel. 4. Telegram, SMS (with DLT fields). 5. Voice link to ai_calls. 6. Meta IG/Messenger (after app review lead time). 7. Webchat. 8. Teams/canned/SLA/CSAT as needed.

### 3.6 Open items to verify before coding
Meta WhatsApp status webhook field names and out-of-window error code; Resend received-email event name and payload; Vapi server-URL auth and call id; MSG91/Gupshup APIs; Telegram rate limits/file size; Chatwoot WebhookJob signing and retry; 24h-window enforcement location in Chatwoot; Papercups/Typebot/Twenty/Rocket.Chat/Mautic/Postal were not studied.
