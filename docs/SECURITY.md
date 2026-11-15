# Security (workstream S)

Status labels: **VERIFIED** = checked against provider docs in research 01 or against our code; **UNVERIFIED** = general knowledge or secondary source, confirm before relying on it (also listed in `OPEN_QUESTIONS.md`).

## 1. Threat model (summary)
| Threat | Primary control | Where |
|---|---|---|
| Auth bypass via Next middleware (CVE-2025-29927, fixed in >= 15.2.3) | Next pinned at 15.5.29; auth never depends on middleware; middleware also rejects `x-middleware-subrequest` (only runs on a patched runtime) | `package.json`, `middleware.ts` |
| Cross-tenant data access (IDOR) | `withAuth` gives `session.org_id`; every query carries `org_id`; `forOrg()` extension; `pnpm check:tenant` static lint; RLS enabled with no policies (denies PostgREST roles) | `lib/api.ts`, `lib/tenant.ts`, `scripts/tenant-isolation-check.ts`, `prisma/rls.sql` |
| Webhook forgery / replay / duplicate side effects | Raw-body HMAC + constant-time compare; dedup table; replay window helper where a signed timestamp exists | `lib/webhook-dedup.ts`, per-route code |
| Cross-tenant WhatsApp routing (H-01) | `organisations.wa_phone_number_id @unique`; settings/onboarding reject a number held by another org with a generic 409 | `lib/tenant.ts`, `app/api/settings`, `app/api/onboarding` |
| Credential / invite brute force, email bombing, abuse | Postgres fixed-window limiter | `lib/rate-limit.ts` |
| CSRF on cookie-auth mutations | `withAuth` rejects a present, mismatching `Origin`; our `omni_session` cookie is set httpOnly + SameSite=Lax (+Secure in production) in lib/auth.ts | `lib/api.ts` |
| Open redirect via `next=` | `safeNextPath` (rejects `//x`, `/\x`, control chars, absolute URLs) used by login page and `/auth/callback` | `lib/safe-redirect.ts` |
| Invite-token theft from a DB leak | 32 random bytes, only sha256 stored, single-use (atomic claim), 7-day expiry, email must match and be confirmed | `app/api/team/*` |
| Secret exposure at rest | AES-256-GCM envelope, key rotation, optional AAD | `lib/crypto.ts` |
| Spreadsheet formula injection in exports | `csvCell()` prefixes `'` for `= + - @ TAB CR` (also after leading whitespace, and full-width variants) | `lib/csv.ts` |
| Clickjacking / MIME sniffing / downgrade | HSTS, `X-Frame-Options`, enforced `frame-ancestors 'none'`, nosniff, Referrer-Policy, Permissions-Policy | `next.config.mjs` |

## 2. What is enforced where
- **Authentication**: every route handler uses `withAuth` (own session cookie validated against `user_sessions`, then `is_active`), or `safe()` plus its own verification. Route files without `withAuth`: `email/track/*` and `email/unsubscribe` (HMAC tokens), `integrations/webhook/*` (per-org HMAC secret), `public/v1/*` (API key), `webhooks/razorpay` (HMAC), `webhooks/whatsapp` and `webhooks/vapi` (owned by other workstreams), `inngest` (SDK signing key, see OPEN_QUESTIONS).
- **Authorisation**: roles viewer < member < admin < owner via `withAuth({ role })`. Admin-only: team, keys, integrations, settings, billing mutations.
- **Tenant scoping**: `org_id` in every `where`. `forOrg(orgId)` forces it for top-level operations. Not covered by `forOrg`: raw SQL, nested relation writes, models without a required `org_id`. `pnpm check:tenant` flags single-record `findUnique/update/delete/upsert` calls with no `org_id` (heuristic; annotate reviewed calls with `// tenant-ok: reason`). At the time of writing it reports calls in files owned by other workstreams.
- **Rate limits** (`rateLimit(key, {limit, windowSec})`, fixed window, DB clock, fails open on store errors):

| Surface | Key | Limit |
|---|---|---|
| `POST /api/auth/signup-complete` | IP | 5/min and 30/day |
| `/auth/callback` | IP | 30/min |
| `POST /api/team/accept` | IP | 10/10 min |
| Team invite and resend | org | 20/hour |
| API key create | org | 10/hour |
| Billing upgrade / cancel | org | 10/hour |
| Public v1 API | IP (pre-auth) and API key | 300/min and 60/min |
| Integration webhook receiver | IP + org | 120/min |
| Razorpay webhook | IP | 300/min |
| Email open / click tracking | IP | 600 / 300 per min (DB write skipped when exceeded) |
| Email unsubscribe | IP | 30/min |
| Any `withAuth` handler | opt-in via `withAuth(fn, { rateLimit })` | n/a |

  Login, signup, forgot and reset are our own routes under `app/api/auth/*` with per-IP and per-email rate limits (see Auth section below).
- **Client IP**: `clientIp(req)` takes the first `X-Forwarded-For` hop. This assumes a proxy that overwrites the header with the real client address (expected on Vercel; UNVERIFIED here). Elsewhere set `CLIENT_IP_HEADER` to an authoritative header, otherwise limits can be evaded by spoofing.
- **Security headers**: HSTS (2 years, includeSubDomains), nosniff, `X-Frame-Options: DENY`, Referrer-Policy `strict-origin-when-cross-origin`, Permissions-Policy (camera, microphone, geolocation, FLoC off). CSP: the enforced policy is only `frame-ancestors 'none'; base-uri 'self'; object-src 'none'`. The full script/style/connect policy ships as **Content-Security-Policy-Report-Only** because Next 15 injects inline bootstrap scripts (an enforcing `script-src` needs nonces) and the Razorpay/Supabase allow-lists could not be tested in a browser here. Promote it after watching violations in a real checkout.
- **Secrets**: per-org tokens (`wa_access_token`, `resend_api_key`, integration config) are encrypted; APIs return booleans or masks only; audit rows store field names, not values; nothing logs tokens (grep verified for console calls in `app/`, `lib/`, `inngest/`).

## 3. Webhook table
| Provider | Signature header | Dedup key | Replay policy | Status |
|---|---|---|---|---|
| Razorpay | `X-Razorpay-Signature` HMAC-SHA256 hex of raw body, `RAZORPAY_WEBHOOK_SECRET` | `razorpay` + `x-razorpay-event-id` (claim, then process, then mark; claim released on handler error so Razorpay retries are processed) | None provided (no signed timestamp). Out-of-order guard: a charged/activated event older than a recorded cancellation is ignored when `created_at` is present | Signature and event-id header VERIFIED (research 01); retry schedule and presence of top-level `created_at` UNVERIFIED |
| Shopify (per-org receiver) | `X-Shopify-Hmac-SHA256` base64 HMAC of raw body | `integration:shopify` + `orgId:X-Shopify-Webhook-Id` | None (no signed timestamp) | Signature and id header VERIFIED |
| Typeform (per-org receiver) | `Typeform-Signature: sha256=<base64>` | `integration:typeform` + `orgId:body.event_id` | None | Signature VERIFIED; `event_id` field UNVERIFIED |
| WooCommerce (per-org receiver) | `X-WC-Webhook-Signature` base64 HMAC | `integration:woocommerce` + `orgId:X-WC-Webhook-Delivery-ID` | None | UNVERIFIED (research 01 could not read the page; header names from memory) |
| WhatsApp (Meta) | `X-Hub-Signature-256` HMAC with App Secret | owned by Agent C: use `claimWebhookEvent("whatsapp", <wamid+status+ts or message id>)` | Meta documents retries up to 36 h; no signed timestamp | Signature VERIFIED (research 01); key derivation for statuses is a design choice |
| Vapi | owned by Agent C (`verifyVapiSecret`) | owned by Agent C | unknown | Auth mechanism UNVERIFIED |
| Resend (Svix) | not implemented in this repo | would use `svix-id` | `assertFresh(svix-timestamp)` | Signature scheme VERIFIED; unused |

Shared helpers (`lib/webhook-dedup.ts`): `claimWebhookEvent(provider, eventId, orgId?) -> Promise<boolean>` (true = first time; also re-claims an unprocessed claim older than 5 minutes), `markProcessed(provider, eventId)`, `releaseWebhookEvent(provider, eventId)`, `assertFresh(timestampSec, toleranceSec = 300)` (throws ApiError 401; call only with a timestamp covered by the signature).

Integration receivers answer 401 for both "no such integration" and "bad signature" (no existence oracle). Note that GET verification in the WhatsApp route (`hub.verify_token` with `===`) is owned by Agent C.

## 4. Key-rotation runbook
Ciphertext format: `v1:<keyId>:<base64(iv|tag|ct)>`, `keyId` = first 8 hex chars of sha256(key). Legacy unprefixed values are still readable.
1. Generate a new key: `openssl rand -hex 32`.
2. Set `ENCRYPTION_KEY_PREVIOUS` = the old `ENCRYPTION_KEY` value, then `ENCRYPTION_KEY` = the new key. Deploy. Reads of old data keep working (legacy values try the current key, then the previous key; v1 values select by keyId).
3. Re-encrypt: for each encrypted column (`organisations.wa_access_token`, `organisations.resend_api_key`, `integrations.config`, `inboxes.config`) run `needsReencrypt(v) ? reencrypt(v) : v` and write back (a one-off tsx script; helpers are exported from `lib/crypto.ts`). Writes touching these columns elsewhere are unaffected.
4. After every row reports `needsReencrypt === false`, remove `ENCRYPTION_KEY_PREVIOUS`.
Caveats: `lib/email` derives HMAC keys for unsubscribe/tracking tokens from `ENCRYPTION_KEY`, so rotating it invalidates previously sent unsubscribe and tracking links (audit L-07; separate `HMAC_SECRET` recommended, not done because `lib/email` is another workstream's file). AAD is supported by `encrypt(plain, aad)` / `decrypt(payload, aad)` but is not used by any call site yet: all readers (`lib/whatsapp`, `lib/email`, `lib/channels`) would have to pass the same value, so adopt it per column together with their owners.
Other secrets: rotate `RAZORPAY_WEBHOOK_SECRET` in the Razorpay dashboard and the env at the same time (a short window of 401s causes Razorpay retries); integration secrets rotate by reconnecting the integration (new secret shown once); API keys rotate by creating a new key and deleting the old one.

## 5. Findings status (workstream S)
- Fixed: H-01 (unique + validation; Meta ownership proof not implemented), H-02, H-03, M-03, M-06 (listed surfaces), M-08, M-10 (a-d), M-16 (`lib/env.ts`; other workstreams' files still carry their own fallbacks), M-19 (partial: rate limit, recent-signup restriction), M-20, L-02 (public trigger side), L-03, L-04 (receiver side), L-05, L-06 (magic-byte check; domain uniqueness not done, needs a schema change), L-14.
- Disproved or corrected: audit "auth/callback and login `next` params are same-origin only" was incomplete: login used `startsWith("/") && !startsWith("//")`, which accepts `/\evil.com`. A browser resolves that to `//evil.com` for `router.replace`. Fixed with `safeNextPath`. (The server-side callback prepends the origin, so it was not exploitable there.)
- Not done here (not in this slice or needs schema): M-14 re-activation of erased contacts (`app/api/public/_contact.ts` still sets `is_active: true`; needs an `erased_at` marker), M-15 Inngest signing assertion, L-07, per-RLS policies (sketch in `prisma/rls.sql`).

## Auth (own implementation)
- Passwords: scrypt (N=2^17), constant-time compare, dummy hash for unknown emails (no timing oracle).
- Sessions: random 256-bit token in an httpOnly, SameSite=Lax, Secure(prod) cookie `omni_session`; only sha256 stored in `user_sessions`; 30-day expiry; revoked on password reset and logout.
- Verify-email / reset tokens: single-use, hashed, 24h / 1h, atomic consume. Forgot-password never reveals whether an account exists.
- Brute force: per-IP and per-email rate limits on login/signup/forgot/reset. CSRF: Origin check on all auth mutations.
- Middleware only checks cookie presence; getSession()/withAuth validate it in the DB.
- Supabase REST/PostgREST is locked down via prisma/rls.sql (RLS on, no policies).
- NOT built yet: Google sign-in, 2FA, account lockout notifications, session list UI.
