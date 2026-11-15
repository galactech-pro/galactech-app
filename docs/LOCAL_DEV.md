# Local development

Everything below runs from **PowerShell or cmd** (Git Bash cannot find node on this machine).

## 1. One-time setup
```powershell
pnpm install                      # also runs prisma generate
copy .env.example .env.local      # then fill DATABASE_URL, DIRECT_URL, ENCRYPTION_KEY
copy .env.local .env              # the Prisma CLI reads ONLY .env; keep the two files identical
pnpm db:push                      # creates the tables
pnpm db:seed                      # plan limits (edit numbers in prisma/seed.ts first if you like)
pnpm db:rls                       # locks Supabase's public REST API (re-run after every db:push)
pnpm doctor                       # validates env + DB + Resend; fix anything marked MISSING
```
Generate the encryption key once: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### Database URLs (Supabase as plain Postgres)
- Locally use the **Session pooler** string (Supabase -> Connect -> Session pooler) for both `DATABASE_URL` and `DIRECT_URL`, ending in `?sslmode=require&connect_timeout=30`. The `db.<ref>.supabase.co` host is IPv6-only and fails on most home networks.
- The session pooler allows **15 clients in total** across every process (dev server, scripts, Inngest). The app limits itself to 4 connections per process automatically (`lib/db-url.ts`; override with `DB_POOL_SIZE` or an explicit `connection_limit`). If you see `EMAXCONNSESSION`, you have too many dev servers or scripts open: close some, or point `DATABASE_URL` at the transaction pooler (port 6543, `?pgbouncer=true&sslmode=require&connection_limit=1`) while keeping `DIRECT_URL` on the session pooler.

## 2. Run it
```powershell
pnpm dev                          # http://localhost:3000
pnpm inngest:dev                  # second terminal: background jobs (campaigns, retries, cron). Dashboard: http://localhost:8288
```
Sign up at `/signup`. Auth is built in (email + password).

## 3. Email in development
| Mode | Setup | What happens |
|---|---|---|
| **No key** (default) | leave `RESEND_API_KEY` empty | New accounts are auto-verified; the verify / reset links are printed in the `pnpm dev` terminal. Zero setup. |
| **Resend sandbox** | `RESEND_API_KEY=re_...` and `EMAIL_FROM=OmniReach <onboarding@resend.dev>` | Real sends, but only to **your own Resend login address**. Good for testing templates. |
| **Your domain** | Verify a domain in Resend (add its SPF + DKIM DNS records, optionally DMARC), then `EMAIL_FROM=OmniReach <hello@mail.yourdomain.com>` | Sends to anyone. Needed before real users sign up. |

`pnpm doctor` calls Resend and tells you whether the key is valid and whether the `EMAIL_FROM` domain is verified.

## 4. Webhooks on your laptop (WhatsApp, Instagram, Messenger, Telegram, Razorpay, Vapi)
Providers need a public HTTPS URL. Start a tunnel in another terminal:
```powershell
cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com  (or: ngrok http 3000)
```
1. Set `NEXT_PUBLIC_APP_URL` to that tunnel URL in `.env.local` and restart `pnpm dev` (links in emails and the Telegram webhook registration use it). Switch it back to `http://localhost:3000` when done.
2. Register webhooks with the provider:

| Channel | Callback URL | Notes |
|---|---|---|
| WhatsApp | `<tunnel>/api/webhooks/whatsapp` | verify token = `WA_WEBHOOK_VERIFY_TOKEN`; subscribe to `messages`; set `WA_APP_SECRET` |
| Instagram / Messenger | `<tunnel>/api/webhooks/meta` | `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` |
| Razorpay | `<tunnel>/api/webhooks/razorpay` | `RAZORPAY_WEBHOOK_SECRET` |
| Vapi | `<tunnel>/api/webhooks/vapi` | header `x-vapi-secret` = `VAPI_WEBHOOK_SECRET` |
| Telegram | registered automatically when you connect the bot | needs the public URL above |

## 5. Telegram quickstart (free, no approval)
1. Telegram -> message **@BotFather** -> `/newbot` -> copy the token.
2. Run a tunnel (section 4) and set `NEXT_PUBLIC_APP_URL` to it.
3. In the app: **Channels -> Telegram**, paste the token.
4. Message your bot from your phone. The conversation appears in **Inbox**; reply from there.

## 6. Checks
```powershell
pnpm exec tsc --noEmit            # types
pnpm check:tenant                 # every query is scoped by org_id
pnpm check:idempotency            # every send goes through the outbox
pnpm check:ai                     # AI guardrail tests
pnpm smoke:auth                   # end-to-end auth test (see below)
```
**Auth smoke test** (creates and deletes throw-away accounts; needs a server running):
```powershell
$env:NEXT_DIST_DIR=".next-smoke"; pnpm exec next dev -p 3100     # terminal A (own build dir so it can run next to :3000)
pnpm smoke:auth                                                    # terminal B (BASE_URL defaults to http://localhost:3100)
```
The server and the script must use the same database. Scripts load `.env.local` automatically (`--env-file-if-exists`).

## Troubleshooting
| Symptom | Fix |
|---|---|
| `P1001 Can't reach database server` | You are on the IPv6-only direct host. Use the session pooler string. |
| `EMAXCONNSESSION max clients reached` | Too many processes on the session pooler (limit 15). Close extra dev servers, or use the transaction pooler for `DATABASE_URL`. |
| `Environment variable not found: DIRECT_URL` from `prisma` | The Prisma CLI reads `.env`, not `.env.local`. Copy it. |
| Prisma `P2021 table does not exist` | Run `pnpm db:push`. |
| Logged in but bounced to `/login` | Cookie is `Secure` only in production; on `next start` over plain http the browser drops it. Use `pnpm dev`, or https. |
| Verification email never arrives | Check `pnpm doctor`. Sandbox sender only reaches your own Resend email. |
