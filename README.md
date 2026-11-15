# OmniReach

WhatsApp + Email + AI voice follow-ups, CRM, automations and analytics for Indian SMBs. One Next.js 15 app (UI + API), Postgres (hosted on Supabase), Prisma, Inngest for background jobs.
See `ARCHITECTURE.md` for design decisions and conventions.

## Setup
1. `pnpm install` (run from PowerShell/cmd; `postinstall` runs `prisma generate`).
2. Copy `.env.example` -> `.env.local` and fill it. Generate `ENCRYPTION_KEY` with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Copy the same file to `.env` (the Prisma CLI reads only `.env`).
3. **Database (Supabase used purely as Postgres)**: set `DATABASE_URL` and `DIRECT_URL` to the *Session pooler* string (Connect button -> Session pooler) with `?sslmode=require&connect_timeout=30`. The direct `db.<ref>.supabase.co` host is IPv6-only and fails on many networks. No Supabase API keys are used.
4. `pnpm db:push` -> `pnpm db:seed` (plan limits: edit numbers in `prisma/seed.ts`) -> `pnpm exec prisma db execute --file prisma/rls.sql --schema prisma/schema.prisma` (locks the Supabase REST API; re-run after each db:push).
5. Terminal 1: `pnpm dev`. Terminal 2: `pnpm inngest:dev` (Inngest dev server; functions at `/api/inngest`).
6. Auth is built in (email + password, email verification, password reset). Without `RESEND_API_KEY` in development, accounts are auto-verified and links are logged.

## Keys by feature (app works without the ones you skip; that feature returns a clear error)
| Feature | Env |
|---|---|
| DB | `DATABASE_URL`, `DIRECT_URL` (Supabase Postgres) |
| Auth | none (built in); `RESEND_API_KEY` for verification/reset emails |
| WhatsApp | per-org token/phone id saved in Settings or onboarding; `WA_APP_SECRET`, `WA_WEBHOOK_VERIFY_TOKEN`. Webhook URL: `<app>/api/webhooks/whatsapp` |
| Email | `RESEND_API_KEY`, `EMAIL_FROM` |
| AI | `GEMINI_API_KEY` (+ optional `ANTHROPIC_API_KEY`) |
| Voice | `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `VAPI_WEBHOOK_SECRET` (sent as `x-vapi-secret`), optional `ELEVENLABS_API_KEY`. Webhook: `<app>/api/webhooks/vapi` |
| Billing | `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET`. Webhook: `<app>/api/webhooks/razorpay` |
| Jobs (prod) | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` |

## Deploy
Vercel (set all env vars, add the Inngest Vercel integration). No second server needed.

## Status / known gaps
Built per the PDF, typechecks and `next build` pass. **Nothing has been exercised against live Supabase/Meta/Vapi/Razorpay yet** - do a test-mode pass for each provider before launch.
Gaps: Zoho/Calendly/Google Sheets are connect-only (no sync); notification preferences and outbound webhooks aren't persisted; no delete-organisation API; no plan switching between paid tiers or annual checkout; custom domain stores the string only; campaign archive missing; PDF export is basic text.

## Hardening pass (security, sync, channels, AI) - read these before launch
- `docs/research/01-04` - sourced research + code audit (44 findings; fixes tracked in `docs/REMEDIATION_PLAN.md`).
- `docs/SECURITY.md` (webhook table, key rotation), `docs/CHANNELS.md` (pipeline + how to add a channel), `docs/COMPLIANCE.md` (consent sources), `docs/OPEN_QUESTIONS.md` (**UNVERIFIED legal/provider facts - confirm before production**).
- `docs/META_SETUP.md` - how to get WhatsApp / Instagram / Messenger / Telegram access and what Meta review needs.
- Checks: `pnpm typecheck`, `pnpm check:tenant`, `pnpm exec tsx scripts/{idempotency-check,ai-guard-check,ai-eval}.ts`.
- Channels: WhatsApp, Email, Voice (Vapi), Telegram, Messenger, Instagram, SMS (Twilio), Web chat, API - connect at `/channels`. Extra env: `META_APP_SECRET`, `STOP_SCOPE`, `AI_CALL_DISCLOSURE_*`, `ENCRYPTION_KEY_PREVIOUS`, `INNGEST_SIGNING_KEY` (required in production).
- Safety defaults: AI-written messages need human approval (`/drafts`); automatic outreach is OFF until enabled AND the contact has recorded consent; an inbound message is NOT marketing consent.
- After `pnpm db:push`, smoke-test the raw-SQL pieces (rate limiter, usage reservation, webhook dedup, inbox list) - they have never run against a real database.
