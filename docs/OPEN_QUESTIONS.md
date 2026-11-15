# Open questions (UNVERIFIED items; do not treat as fact)


## Security / platform (workstream S)
- Vercel (or the chosen host) overwrites `X-Forwarded-For` with the real client IP, making the first hop trustworthy for `clientIp()`. Not verified; set `CLIENT_IP_HEADER` elsewhere.
- Supabase auth cookies are SameSite=Lax and Supabase Auth applies its own rate limits to sign-in, sign-up and password reset (our code has no server route for them). Check dashboard settings.
- Razorpay: retry schedule, and whether every webhook payload carries a top-level `created_at` (used only as an optional ordering guard). `x-razorpay-event-id` and signature are VERIFIED in research 01.
- Typeform `event_id` body field and WooCommerce `X-WC-Webhook-Delivery-ID` header (used for integration dedup) are from memory. WooCommerce signature scheme is also UNVERIFIED (research 01).
- Vapi server authentication and retry behaviour (owned by Agent C).
- Razorpay Checkout CSP hosts (`checkout.razorpay.com`, `api.razorpay.com`, `lumberjack.razorpay.com`) in the Report-Only CSP are from general knowledge; confirm with a real checkout, then enforce.
- Prove WhatsApp number ownership: on connect, call Meta `GET /{phone_number_id}` with the supplied token and require success (audit H-01 recommendation, Graph API details UNVERIFIED here). Without it, an admin can still squat another tenant's not-yet-connected `phone_number_id` (the `@unique` stops hijack of a connected one, not pre-registration).
- `WA_APP_SECRET` is one global secret: tenants bringing their own Meta app would fail signature verification (audit H-01 note). Confirm all tenants use the platform app (Embedded Signup).
- Row-level security as a second layer (needs a non-owner DB role and `set_config` per transaction; Prisma + Supabase pooler compatibility UNVERIFIED, sketch in `prisma/rls.sql`).
- Inngest: `INNGEST_SIGNING_KEY` enforcement and event-id idempotency (audit M-15, research 01); route is owned by another workstream.
- `lib/email` and `lib/voice` still use `NEXT_PUBLIC_APP_URL || "http://localhost:3000"`; they should import `appUrl()` from `lib/env.ts` (audit M-16).
- `lib/analytics.ts` `csvEscape` lacks the leading-whitespace/full-width cases of `lib/csv.ts` (file not in this slice).
- Erased contacts are re-activated by the public API/integrations (audit M-14): needs an `erased_at` column.

## AI guardrails & compliance flows (workstream A)
All items below are configurable in code/env/org settings and labelled UNVERIFIED in comments; none is asserted as law.
- Calling-hours window: org columns `call_window_start/end` default 09:00-21:00 (secondary vendor source only, research 01 TRAI section). Confirm the primary TRAI text, whether it applies to AI/outbound calls from a business, and DND/NCPR scrubbing duties before enabling auto-dial in production.
- AI-call disclosure: `lib/ai/guards.ts getVoiceConfig` prepends a disclosure line by default (`AI_CALL_DISCLOSURE_ENABLED=true`, text via `AI_CALL_DISCLOSURE_TEXT`). Whether Indian law requires disclosure of an AI voice, and recording-consent rules, are UNVERIFIED. Default ON is the conservative choice.
- CSV import attestation (`consent_attested`, source `import_attested`): whether a bulk self-attestation by the importer is adequate evidence under DPDP/TRAI/WhatsApp policy is UNVERIFIED. DPDP Rules 2025 commencement dates in research 01/03 are also UNVERIFIED against the Gazette.
- STOP handling: keyword list (`OPT_OUT_KEYWORDS`, default includes "cancel" and Hinglish) and scope (`STOP_SCOPE=all|channel`, default `all` = also revokes voice/sms/email marketing consent). Policy choice and statutory 7-day/immediate timelines UNVERIFIED. Over-matching ("cancel my order") is a known trade-off.
- `AI_DAILY_RUN_CAP` (default 500 LLM attempts per org per 24h), `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS` are placeholder limits, not tuned to real plan economics or provider pricing.
- Claude path uses prompt-level JSON (SDK 0.32.1 predates `output_config` structured outputs); Gemini uses `responseMimeType` JSON mode without `responseSchema`. Zod is the enforced gate either way. Upgrade the SDKs (package.json is not in this slice) to use provider schema modes.
- Grounding checks are regex heuristics (currency, %, URL, phone, email, a short promise-word list). They will miss spelled-out numbers ("fifty percent"), dates/deadlines and semantic fabrications; human approval stays the primary control. Measure the human edit/reject rate on `ai_drafts` before relaxing `ai_approval_required`.
- `predicted_open_rate` in subject lines is an LLM guess, not a measurement (kept for API compatibility).
- Lead score weights (`lib/ai/scoring.ts`, version `feat-v1`) are hand-set, not fitted to real conversion data.

## Consent policy (workstream H)
- Is an inbound message sufficient opt-in for follow-up templates? (we assume NO) `recordInboundConsent` is now a documented no-op; an inbound message only opens the 24h service window. Marketing consent comes solely from the sources in docs/COMPLIANCE.md. Legal position UNVERIFIED; this supersedes the earlier "inbound_message" open question above.

## New channels (workstream N) - all UNVERIFIED items; see docs/CHANNELS.md "Channels shipped"
- Telegram: `sendMessage` 4096-char limit, error/429 `retry_after` body shape (docs section not read).
- Instagram: webhook envelope (`object: "instagram"`, `entry[].id` = IG account id), `is_echo` semantics, `GET /me?fields=user_id,username` on graph.instagram.com, Bearer-header auth, Human Agent tag parameter and approval; Messenger 2000-char limit and `GET /me` check. Delivery/read receipt webhooks not wired. Auto `subscribed_apps` not done.
- Meta: one `META_APP_SECRET` for all tenants (tenants with their own Meta app would fail signature verification); whether the escaped-unicode HMAC fallback is ever needed.
- Twilio: exact signature string concatenation, credential-check endpoint and Basic auth, MessageSid on status callbacks, absence of idempotency; India DLT requirements (org responsibility, not checked).
- Web chat: visitor-id-as-bearer model acceptable? (128-bit random in localStorage; no signed session). Origin allow-list is browser-only protection.
- Compliance gaps: `assertCanContact` enforces `wa_opt_out` only for whatsapp/sms; `inbound.ts` STOP flow only for whatsapp/sms (worked around in adapters/_stop.ts and assertNotOptedOut). Opt-out for telegram/instagram/messenger/webchat is stored in `wa_opt_out` (scope "all") - semantic naming debt.
- `middleware.ts` PROTECTED list lacks `/channels` (page still needs a session through the dashboard layout/API; add it for the redirect).
