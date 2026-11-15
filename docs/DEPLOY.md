# Deploying GalacTech to Vercel

Architecture: one Next.js app on Vercel (UI + API) -> Supabase Postgres (database only) -> Inngest Cloud (background jobs). No other server.

## 0. Before you start
- Code in a Git repo (GitHub / GitLab / Bitbucket).
- Locally: `pnpm doctor` passes and `pnpm smoke:auth` is green.
- A domain you control (about Rs 600-900/yr), e.g. `galactech.in`. Plan to use `app.<domain>` for the app and `mail.<domain>` for email.

## 1. Database (Supabase)
1. Run the schema against the production database **from your laptop**, using the **session pooler** URL:
   ```powershell
   pnpm db:push ; pnpm db:seed ; pnpm db:rls
   ```
   Use a separate Supabase project for production if you can (so test data never mixes with real data), and set `DATABASE_URL`/`DIRECT_URL` in `.env.local` + `.env` to it for these commands.
2. Re-run `pnpm db:rls` after **every** future `db:push` (new tables need row security).
3. Rotate the database password if it was ever pasted anywhere (Supabase -> Project Settings -> Database).

## 2. Create the Vercel project (a NEW, separate project)
1. Vercel -> Add New -> Project -> import the repo. Framework: Next.js (auto). `vercel.json` already sets region `bom1` (Mumbai, next to Supabase `ap-south-1`) and function timeouts.
2. Add the environment variables below (Production, and Preview if you use previews), then deploy.

| Variable | Value | Required |
|---|---|---|
| `DATABASE_URL` | **Transaction pooler**: `postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&sslmode=require&connection_limit=1` | yes |
| `DIRECT_URL` | Session pooler (port 5432) string, `?sslmode=require&connect_timeout=30` | yes (used by prisma) |
| `NEXT_PUBLIC_APP_URL` | `https://app.yourdomain.com` (no trailing slash) | yes |
| `ENCRYPTION_KEY` | 64 hex chars. **Use a NEW key for production and back it up**; losing it makes stored WhatsApp/Resend tokens unreadable | yes |
| `RESEND_API_KEY` | from Resend | yes (sign-up verification + password reset cannot send without it) |
| `EMAIL_FROM` | `GalacTech <hello@mail.yourdomain.com>` | yes |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | from Inngest (section 4) | yes |
| `WA_APP_SECRET`, `WA_WEBHOOK_VERIFY_TOKEN` | Meta app (WhatsApp) | for WhatsApp |
| `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Meta app (Instagram/Messenger) | for IG/Messenger |
| `GEMINI_API_KEY` (+ `ANTHROPIC_API_KEY`) | AI providers | for AI features |
| `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `VAPI_WEBHOOK_SECRET` | Vapi | for voice |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay | for billing |
| `STOP_SCOPE` | `all` (default) | optional |

Never set `NEXT_PUBLIC_*` to a secret: those values are shipped to browsers. The only public variable in this app is `NEXT_PUBLIC_APP_URL`.

## 3. Domain and email DNS
1. Vercel -> Domains: add `app.yourdomain.com` and add the CNAME it shows at your registrar.
2. Resend -> Domains -> add `mail.yourdomain.com`. Add the records Resend shows (SPF TXT, DKIM CNAME/TXT, and a DMARC TXT such as `_dmarc.mail` = `v=DMARC1; p=none; rua=mailto:you@yourdomain.com`). Click Verify (minutes to hours).
3. `EMAIL_FROM` must use an address on that verified domain. `pnpm doctor` (run with production env) confirms it.

## 4. Inngest Cloud (background jobs)
1. inngest.com -> create an app -> Vercel integration (Settings -> Integrations -> Vercel) or copy the keys manually into `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.
2. After the first deploy, Inngest -> Apps -> Sync app: URL `https://app.yourdomain.com/api/inngest`. You should see all functions (campaign send, reconcile cron, call retry, automations).
3. In production `/api/inngest` rejects unsigned requests, so the signing key is mandatory.

## 5. Webhooks (use the production URL, not a tunnel)
| Provider | Where | URL | Secret / token |
|---|---|---|---|
| WhatsApp | Meta app -> WhatsApp -> Configuration | `https://app.yourdomain.com/api/webhooks/whatsapp` | verify token = `WA_WEBHOOK_VERIFY_TOKEN`; subscribe `messages`; signature uses `WA_APP_SECRET` |
| Instagram / Messenger | Meta app -> each product's webhooks | `https://app.yourdomain.com/api/webhooks/meta` | `META_WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET` |
| Telegram | automatic when the bot is connected in `/channels` (needs `NEXT_PUBLIC_APP_URL` correct). Reconnect the bot after changing the domain | `/api/webhooks/telegram/<token>` | - |
| Razorpay | Dashboard -> Webhooks | `https://app.yourdomain.com/api/webhooks/razorpay` | `RAZORPAY_WEBHOOK_SECRET` |
| Vapi | Vapi dashboard -> server URL | `https://app.yourdomain.com/api/webhooks/vapi` | header `x-vapi-secret` = `VAPI_WEBHOOK_SECRET` |

## 6. Post-deploy checklist
- [ ] `https://app.yourdomain.com` loads over https; `/login` and `/signup` render.
- [ ] Sign up with a real email: the verification email arrives, the link works, you land on the dashboard.
- [ ] Forgot password: reset email arrives, the new password works, other sessions are signed out.
- [ ] `pnpm smoke:auth` against production is NOT recommended (it creates data). Run it against a staging deploy or locally.
- [ ] Inngest shows the app synced and functions registered.
- [ ] Connect Telegram (easiest) and send a message: it appears in Inbox, a reply is delivered.
- [ ] WhatsApp webhook verified (green tick in Meta) and a test message appears in Inbox.
- [ ] Supabase -> Table Editor shows RLS **enabled** on every table (or run `pnpm doctor` with the prod env).
- [ ] Response headers include HSTS and `X-Frame-Options` (browser dev tools -> Network).
- [ ] Razorpay: make a test-mode payment; confirm the subscription updates.
- [ ] Rotate any secret that was ever shared in chat or committed.

## Operational notes
- **Cookies** are `Secure` + `HttpOnly` + `SameSite=Lax` in production, so only https works.
- **Passwords** are hashed with scrypt (about 130 MB of memory, 100-300 ms per login). The default Vercel function memory is fine.
- **Client IP** for rate limits comes from `x-vercel-forwarded-for` on Vercel. If you move off Vercel, set `CLIENT_IP_HEADER` to a header your proxy sets itself.
- **Email verification** is recorded but not yet required to use the app. Decide whether to gate sending until verified.
- **Backups:** Supabase free plans have no point-in-time recovery. Enable backups on a paid plan before real customer data arrives.

## Domain layout for galactech.pro
- galactech.pro / www is the existing company website. Do NOT point it at this app, and never deploy this repo into that Vercel project.
- This app lives in its own Vercel project (`galactech-app`) at `app.galactech.pro` (add the CNAME Vercel shows). Set `NEXT_PUBLIC_APP_URL=https://app.galactech.pro` and redeploy after the domain is attached.
- Email is sent from `hello@galactech.pro` (the domain is verified in Resend).

