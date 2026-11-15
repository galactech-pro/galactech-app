# OmniReach - Architecture & Agent Contract

Source spec: `E:\Downloads\OmniReach Complete Build Profile.pdf` (feature list = source of truth for *what*; this doc = *how*).

## Decisions (deviations from the PDF, and why)
| PDF said | We do | Why |
|---|---|---|
| Separate backend / monorepo packages | **One Next.js 15 app.** UI + API in the same repo (`app/api/*` Route Handlers). Integrations are modules in `lib/`. | Solo dev; no CORS/second deploy; webhooks + 3rd-party calls are plain HTTP; Vapi runs the calls. |
| NextAuth **and** Supabase Auth | **Own auth** (lib/auth.ts, lib/password.ts, lib/auth-tokens.ts): scrypt passwords, server-side sessions in `user_sessions` (httpOnly cookie, sha256 stored), email verify + reset tokens. Supabase is ONLY the Postgres host. | No vendor lock-in beyond the DB; no Supabase Auth/Storage/REST. |
| n8n (self-hosted on Railway) + Upstash queue | **Inngest** (`lib/inngest.ts`, functions in `inngest/`, served at `/api/inngest`). Workflows WF-001…010 are typed TS functions. | n8n hosting costs money (spec says ₹0); Vercel can't do multi-day waits/retries/cron - Inngest does, free tier, version-controlled. |
| Gemini 1.5 Flash hard-coded | Model via env `GEMINI_MODEL` / `ANTHROPIC_MODEL`. | 1.5 is retired; avoid code change on next deprecation. |
| Razorpay + Stripe | **Razorpay only** for MVP. | India-first. |
| Prisma + Supabase | Kept. org scoping enforced in code (Prisma bypasses RLS). | Spec rule: every query filters `org_id`. |

## Stack
Next.js 15 App Router · React 19 · TypeScript strict · Tailwind + shadcn/ui (Radix) · Prisma 5 + Postgres (hosted on Supabase) · own session auth · Zod · TanStack Query · React Flow (workflow builder) · Recharts · Inngest · Resend · Meta WhatsApp Cloud API (direct) · Vapi (+ElevenLabs/Twilio inside) · Gemini (primary) + Claude (voice scripts) · Razorpay.
Package manager: **pnpm**. Run shell commands from PowerShell (bash can't find `node`).

## Layout
```
app/(auth)/login|signup|verify-email|forgot-password
app/(dashboard)/<route>/page.tsx      # pages per spec §3.2; layout.tsx = sidebar shell
app/api/**/route.ts                   # spec §3.4
app/api/inngest/route.ts              # serve(inngest, functions)
components/ui/*                       # shadcn primitives
components/app/*                      # feature components
lib/{db,auth,api,limits,crypto,audit,utils,fetcher,inngest}.ts   # EXISTING - do not change signatures
lib/ai/index.ts        lib/whatsapp/index.ts   lib/email/index.ts   lib/voice/index.ts
inngest/*.ts           # WF-001…010 + automation engine. Registry is inngest/functions.ts (NEVER add inngest/index.ts: it shadows the npm package)
prisma/schema.prisma, prisma/seed.ts
```

## Non-negotiable conventions
1. Every API route: `withAuth(handler, {role})` from `lib/api.ts` (or `safe()` for webhooks that verify signatures themselves). Always return `ok(data)` / `fail(msg, status)` → `{ success, data, error }`.
2. Every Prisma query filters by `org_id` from the session. Never trust an id from the client without `org_id` in the `where`.
3. Zod on every body/query (`parseBody`, `parseQuery`). No `any`.
4. Before any send: check `wa_opt_out` / `email_opt_out` / `dnc`, then `checkLimit(orgId, metric)`; after success `incrementUsage`. Log every send to `messages` (`queued` → update).
5. Webhooks: verify signature, return 200 fast, push heavy work to Inngest via `sendEvent`.
6. Next 15: `await cookies()`, `const { id } = await ctx.params`, `await searchParams` in pages.
7. Secrets only from `process.env`; per-org secrets (`wa_access_token`, `resend_api_key`, integration config) encrypted with `lib/crypto.ts`.
8. Client components fetch with `api()` from `lib/fetcher.ts` + TanStack Query. A `FetchError` with `code === "PLAN_LIMIT"` must open the upgrade modal.
9. Soft-delete contacts (`is_active=false`). Phones normalised to E.164 via `normalizePhone`.
10. Graceful when a provider key is missing: return a clear `fail("WhatsApp not connected", 400)`; never crash the app. Mock-free: real code paths only.

## Service-library contracts (lib/*/index.ts) - implement EXACTLY these
```ts
// lib/ai
generateMessage(i:{goal:string; contact:{name:string;company?:string;industry?:string}; channel:"whatsapp"|"email"; tone:"professional"|"friendly"|"urgent"}): Promise<{message:string; subject?:string; alternatives:string[]}>
generateSubjectLines(i:{goal:string; body?:string}): Promise<{variants:{subject:string; predicted_open_rate:number}[]}>
scoreLead(contact: Contact & {messages?:Message[]}): Promise<{score:number /*1-10*/; reason:string; signals:string[]}>
generateCallScript(contact: Contact, org: organisations): Promise<{script:string; first_message:string; objections:string[]}>   // Claude
extractCallOutcome(transcript:string): Promise<{outcome:"interested"|"callback"|"not_interested"|"no_answer"|"voicemail"; summary:string; key_points:string[]}>
generateWeeklyInsights(stats: unknown): Promise<string>
// lib/whatsapp  (credentials resolved from org row, token decrypted inside)
sendMessage(orgId:string, phone:string, text:string, ctx?:{contactId:string; campaignId?:string}): Promise<{messageId:string; waMessageId:string}>
sendTemplate(orgId, phone, templateName:string, params:string[], ctx?): Promise<{...same}>
sendMedia(orgId, phone, {type:"image"|"document"|"video"|"audio"; url:string; caption?:string}, ctx?)
sendInteractive(orgId, phone, body:string, buttons:{id:string;title:string}[], ctx?)
listTemplates(orgId)/createTemplate(orgId, def)
parseWebhook(body:unknown): {messages: InboundMsg[]; statuses: StatusUpdate[]}
verifySignature(rawBody:string, header:string|null): boolean   // X-Hub-Signature-256, WA_APP_SECRET
// lib/email
sendEmail(orgId, {to, subject, html, contactId?, campaignId?}): Promise<{messageId:string}>   // adds unsubscribe link + List-Unsubscribe
sendTransactional(kind:"welcome"|"password_reset"|"invoice"|"trial_ending"|"invite", to:string, data:Record<string,unknown>)
unsubscribeToken(contactId):string / verifyUnsubscribeToken(token):string|null     // HMAC
// lib/voice
initiateCall(orgId, contactId, customScript?): Promise<{aiCallId:string; vapiCallId:string}>   // checks dnc + limit, saves ai_calls
parseVapiWebhook(body:unknown): {vapiCallId:string; type:string; transcript?:string; durationSeconds?:number; recordingUrl?:string; costInr?:number; endedReason?:string}
verifyVapiSecret(req:Request):boolean
listVoices(): Promise<{id:string;name:string;gender:string;preview_url?:string}[]>
```

## Inngest events (see `lib/inngest.ts` `Events`) → functions in `inngest/`
WF-001 new lead welcome · WF-002 follow-up sequence · WF-003 hot lead alert · WF-004 reply handler · WF-005 trial ending (cron) · WF-006 call post-processing · WF-007 payment success · WF-008 churn prevention (cron) · WF-009 weekly report (cron Mon 09:00 IST) · WF-010 agency sub-client · `automation-engine` (interprets `automations.steps` React-Flow graph incl. delays) · `campaign-send` (rate-limited batch send, 3 retries) · `call-retry` (2h → next day → stop at 3).
Slack alerts: optional `SLACK_WEBHOOK_URL` env; skip silently if unset.

## File ownership (agents must not edit files outside their slice)
- **A - Foundation UI/Auth:** `components/ui/**`, `components/app/{shell,sidebar,providers,upgrade-modal}*`, `app/(auth)/**`, `app/(dashboard)/layout.tsx`, `app/page.tsx` (landing), `app/api/auth/**`, `app/(dashboard)/dashboard/**`, `app/api/stats/**`, `app/(dashboard)/onboarding/**`, `app/api/onboarding/**`, privacy/terms pages.
- **B - Service libs + webhooks + Inngest:** `lib/{ai,whatsapp,email,voice}/**`, `app/api/webhooks/{whatsapp,vapi}/**`, `app/api/ai/**`, `app/api/inngest/**`, `inngest/**`.
- **C1 - CRM/Messaging/Voice API:** `app/api/{contacts,campaigns,inbox,voice}/**` (not webhooks).
- **C2 - Platform API:** `app/api/{automations,analytics,settings,team,billing,keys,integrations}/**`, `app/api/webhooks/razorpay/**`, `lib/razorpay.ts`, `lib/analytics.ts`, `lib/automation-graph.ts`.
- **Phase 2 pages:** D contacts+campaigns+inbox · E voice+analytics+automations(React Flow) · F settings+team+billing+integrations.
