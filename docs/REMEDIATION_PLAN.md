# Remediation plan (from docs/research/01-04)

Inputs: 01 security/auth/webhooks · 02 Chatwoot/omnichannel · 03 tenancy/sync/AI · 04 code audit (0 Critical / 9 High / 19 Medium / 16 Low).
Rule for everyone: **do not assert anything marked UNVERIFIED in the research as fact** (TRAI hours, DPDP dates, Vapi auth, SMS vendor APIs). Make such rules configurable, label them in code comments, and list them in docs/OPEN_QUESTIONS.md.

## Already done by the lead (shared foundation - do not redo)
- Schema: `inboxes, contact_inboxes, conversations, webhook_events, consents, ai_drafts, ai_runs, rate_limits`; `messages.{inbox_id,conversation_id,external_id,idempotency_key}` with `@@unique([inbox_id, external_id])`; `channel` enum widened (telegram, instagram, messenger, webchat, api); `organisations.wa_phone_number_id @unique`, `call_window_*`, `auto_outreach_enabled`, `ai_approval_required`; `contacts.version`.
- `lib/compliance/index.ts`: `assertCanContact(orgId, contactId, channel, {purpose, automated?})` + `recordConsent()` + `ComplianceError`. ALL send paths must call it.
- No DB is available: schema is validated with `prisma validate/generate` only. Provide SQL-free migrations via `prisma db push` instructions; never assume a live DB.

## Workstreams (disjoint file ownership)
- **S - Security & platform** (`next` upgrade, headers, rate limiting, auth/invite fixes, tenant-scoped DB helper, webhook dedup util, CSV injection, URL fallbacks, secrets/key-versioning). Audit: H-01, H-02, H-03, M-03, M-06, M-16 + research 01 P0.
- **C - Channels & sync core** (`lib/channels/**` adapter interface + registry; WhatsApp/Email/Voice adapters; inbox/conversation/contact_inbox creation; idempotent inbound; monotonic status; outbox send with idempotency key; WA window + template enforcement; campaign worker atomicity; Vapi webhook idempotency; inbox API/UI on conversations). Audit: H-04, H-07, H-08, M-01, M-02 + research 02/03.
- **A - AI guardrails & compliance flows** (`lib/ai/**`, `lib/compliance/**` extensions, `inngest/wf-*.ts`, `inngest/automation-engine.ts`, ai_drafts approval API+UI, consent capture in import/API/forms, settings toggles). Audit: H-05, H-06, H-09, M-12, M-13.
- **N - New channels** (after C): Telegram, Instagram DM + Messenger, SMS (provider-agnostic Twilio adapter; DLT unverified), web chat widget, generic API channel; Inbox management UI (connect/disconnect channels).
