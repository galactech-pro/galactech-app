# 01 - Security, Auth, Webhooks, Compliance (OmniReach AI)

Research date: 2026-11-14. Stack: Next.js 15, Supabase Auth, Prisma, Inngest, multi-tenant, WhatsApp/email/voice to Indian leads.
Legend: **Verified** = read in a fetched primary/vendor doc this session. **UNVERIFIED** = from general knowledge or secondary source; check before relying on it. No code was edited. File paths below are hints (adapt to actual repo layout).

---

## 1. Inbound webhooks

### Best practice
- Verify signature over the **raw, unparsed body**; any JSON re-stringify breaks it. Stripe: https://docs.stripe.com/webhooks ; Razorpay ("Do not parse or cast the webhook request body"): https://razorpay.com/docs/webhooks/validate-test/ ; Resend/Svix: https://resend.com/docs/webhooks/verify-webhooks-requests ; Shopify: https://shopify.dev/docs/apps/build/webhooks/subscribe/https ; Typeform: https://www.typeform.com/developers/webhooks/secure-your-webhooks/
- **Constant-time compare** (Svix: https://docs.svix.com/receiving/verifying-payloads/how-manual ; Stripe). Use `crypto.timingSafeEqual` after length check.
- **Replay window**: timestamp is signed; Stripe libs default tolerance 5 min, never 0 (Stripe doc). Svix gives `svix-timestamp` but leaves window to you (Svix doc). Signed content for Svix = `${svix-id}.${svix-timestamp}.${body}`, key = base64-decoded part after `whsec_`, header may carry multiple space-separated `v1,` sigs (Svix doc).
- **Dedup**: persist event IDs and skip repeats (Stripe; Razorpay `x-razorpay-event-id`; Shopify `X-Shopify-Webhook-Id`). Do not use `created` for ordering (Stripe: second resolution, no ordering guarantee).
- **Ordering is not guaranteed** (Stripe; Razorpay: `payment.captured` may precede `payment.authorized`). Model status as a monotonic state machine (see below).
- **Respond fast, process async** (Stripe: return 2xx before complex logic, use a queue; Shopify: 1s connect / 5s total timeout, 8 retries over 4h, subscription auto-deleted after 8 consecutive failures).
- **Secret rotation**: Stripe supports overlapping secrets up to 7 days, one signature per secret; verify "any v1 matches". Razorpay: use old secret to validate retried old requests after rotation.

### Per-provider facts
| Provider | Signature | Retry / notes | Status |
|---|---|---|---|
| Meta (WhatsApp Cloud) | `X-Hub-Signature-256: sha256=<hex>` HMAC-SHA256 with **App Secret** (page says validation is optional but "you should"; page does not state raw-body explicitly, hash raw bytes). GET verify: check `hub.verify_token`, echo `hub.challenge`. | Immediate retry then decreasing frequency up to 36h, then dropped; may be batched up to 1000 updates; dedup yourself; respond 200. Optional mTLS (CN `client.webhooks.fbclientcerts.com`). https://developers.facebook.com/docs/graph-api/webhooks/getting-started | Verified |
| Razorpay | `X-Razorpay-Signature` HMAC-SHA256(secret, raw body); `x-razorpay-event-id` for dedup. | Retry schedule/timeouts NOT on the page. | Verified (sig, dedup); retry UNVERIFIED |
| Resend (Svix) | `svix-id/-timestamp/-signature`, raw body. | Retry schedule and tolerance not on fetched page (see Resend "retries and replays" guide). Resend allows replay of events. | Verified (sig); retry UNVERIFIED |
| Vapi | Page fetched did not document auth; the `securing-endpoints` URL I guessed 404'd. Vapi supports a server "secret"/credential header per UNVERIFIED memory. | Event types confirmed: status-update, transcript, function-call, assistant-request, end-of-call-report, hang. https://docs.vapi.ai/server-url | Event list verified; auth/retry UNVERIFIED - read https://docs.vapi.ai (Server URLs / Authentication) before building |
| Typeform | `Typeform-Signature: sha256=` + base64(HMAC-SHA256(secret, raw body)). | Retries not on page. | sig Verified; retries UNVERIFIED |
| Shopify | `X-Shopify-Hmac-SHA256` base64 HMAC of raw body with app client secret; dedup `X-Shopify-Webhook-Id`. | See above. | Verified |
| WooCommerce | `X-WC-Webhook-Signature` base64 HMAC-SHA256 with webhook secret; auto-disable after repeated failures. | Fetched page truncated before webhook section. | UNVERIFIED |

### Risk if ignored
Forged status/payment events (fake "delivered", fake paid), duplicate side effects (double credits, double sends), lost events when handler is slow, stale-status overwrites.

### How to implement here
- One route per provider: `app/api/webhooks/{meta,razorpay,vapi,resend,typeform,shopify,woocommerce}/route.ts`, each `export const runtime = 'nodejs'` and using `const raw = await req.text()` (or `Buffer.from(await req.arrayBuffer())`) **before** any `.json()`. Never put these through middleware body parsing.
- Shared helper `lib/webhooks/verify.ts`: `hmacSha256(secret, data)`, `safeEqual(a,b)` via `timingSafeEqual` (check equal lengths first), timestamp tolerance helper.
- Dedup table (Prisma): `WebhookEvent { id, provider, externalEventId, tenantId?, receivedAt, processedAt, status, payloadHash }` with `@@unique([provider, externalEventId])`. Insert-first (`createMany skipDuplicates` or catch P2002); only enqueue if newly inserted. Where the provider has no event id (Meta statuses), derive key = `waMessageId + status + timestamp`.
- Handler flow: verify -> insert dedup row -> `inngest.send({ name: 'webhook/<provider>.received', id: dedupKey, data })` -> return 200. Inngest `id` on send gives idempotent event ingestion (UNVERIFIED in this session - the serve doc fetched did not cover event idempotency; confirm at https://www.inngest.com/docs/guides/handling-idempotency).
- Status ordering: store numeric rank (queued<sent<delivered<read; failed terminal) and `UPDATE ... WHERE rank < :new` so late events never regress state. Same for Razorpay payment states.
- Per-tenant secrets: for customer-connected sources (Typeform, Shopify, WooCommerce) put an opaque `endpointId` in URL (`/api/webhooks/shopify/[endpointId]`), look up tenant + encrypted secret (see section 5), verify with that secret. Meta app secret is per-app (one), but resolve tenant from `phone_number_id`/WABA id in payload after verification. Reject if mapping unknown.
- Secret rotation: store `secret_current` and `secret_previous` + `previous_expires_at`; accept either.
- Inngest serve endpoint (`app/api/inngest/route.ts`): set `INNGEST_SIGNING_KEY` via env var (Inngest recommends env over option; https://www.inngest.com/docs/reference/serve). Request-signature verification details not covered by fetched text - UNVERIFIED but SDK does it when key is set.
- Never rely on IP allowlists alone (Stripe recommends both signature + IP allowlist for Stripe only).

Confidence: **Verified** for signature/raw-body/dedup/ordering/Meta+Shopify retry; **UNVERIFIED** for Vapi auth, Razorpay/Resend/Typeform retry, WooCommerce, Inngest event idempotency.

---

## 2. Outbound webhooks (customer-facing)

### Best practice
- HMAC-SHA256 sign `${id}.${timestamp}.${body}` and send `id`, `timestamp`, `signature` headers; copy the Svix/Stripe scheme (both verified above), support multiple active signatures for rotation, per-endpoint secret shown once.
- **SSRF**: OWASP SSRF cheat sheet https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html - allowlist if possible; otherwise resolve DNS, check **every** A/AAAA against blocklist (loopback, RFC1918, link-local incl. 169.254.169.254, IPv6 ULA/link-local, multicast, metadata hosts), normalise IPv4-mapped/NAT64, connect only to the validated IP (keep Host/SNI), **disable redirects**, apply same on retries; restrict egress at network level; reject URL parser disagreements.
- Retries: exponential backoff with jitter over days (Stripe: up to 3 days, redirects count as failure, 2xx required). Auto-disable endpoints after sustained failure (Shopify disables after 8 consecutive failures).
- Delivery log: per attempt store status code, latency, truncated response body (size-capped, redacted), next retry; allow manual replay.

### Risk
SSRF into internal network / cloud metadata via customer-supplied URL; secret leakage; retry storms against customer.

### How to implement here
- Prisma: `WebhookEndpoint(tenantId, url, secretEnc, enabled, events[])`, `WebhookDelivery(endpointId, eventId, attempt, status, httpStatus, durationMs, responseSnippet, nextAttemptAt)`.
- Delivery as Inngest function with `retries` and step-level `step.run` per attempt; HTTPS only, ports 443 (or allowlisted), 5-10s timeout, response size cap, `redirect: 'manual'`.
- SSRF-safe fetch wrapper `lib/net/safeFetch.ts`: use `dns.lookup({all:true})`, validate with an IP-range library (e.g. `ipaddr.js`; library choice is a suggestion, not verified), then use an `undici` Agent with custom `connect.lookup` pinned to the validated IP. Re-run on each retry. Validate at save time AND at send time (DNS rebinding).
- Run delivery workers where egress to private ranges is blocked (infra-level).

Confidence: SSRF and retry/log patterns **Verified**; library names **UNVERIFIED** suggestions.

---

## 3. Auth (Supabase + Next.js 15)

### Best practice
- **Server-side: never trust `getSession()`** for authorization; it does not revalidate; cookies can be forged. Use `getClaims()` (verifies token) or `getUser()` (network call to Auth server) - https://supabase.com/docs/guides/auth/server-side/nextjs
- Next.js 15 file is `middleware.ts` (renamed `proxy.ts` in Next 16) and refreshes session cookies; return the `supabaseResponse` object or copy cookies; refresh tokens are single-use so refreshing in two places can sign users out; set no-cache headers on responses that set cookies to avoid cross-user session leak via CDN (Supabase doc).
- **CVE-2025-29927**: attacker supplies `x-middleware-subrequest` header to skip middleware; fixed in 15.2.3, 14.2.25, 13.5.9, 12.3.5; self-hosted (`next start`/standalone) affected, Vercel/Netlify not; mitigation: upgrade, strip the header at the edge/proxy, **don't rely on middleware as sole protection** - https://vercel.com/blog/postmortem-on-next-js-middleware-bypass
- Next.js data-security guide: use a server-only **Data Access Layer** doing authn + authz + returning DTOs; every Server Action is a public POST endpoint and must re-check auth and **resource ownership** (IDOR); validate all input; Server Actions compare Origin to Host (CSRF defence), configure `serverActions.allowedOrigins` behind proxies; mutations are POST only; audit `route.ts` and middleware closely - https://nextjs.org/docs/app/guides/data-security
- Non-Supabase topics - OAuth redirect validation (exact-match allowlist of redirect URIs, validate `next=` params as same-origin relative paths), session fixation (rotate session on login; Supabase issues new tokens on sign-in), MFA (Supabase offers TOTP MFA), invite tokens (random >=128-bit, store only SHA-256 hash, single-use, expiry, bind to email+org+role), API keys (prefix + random secret, show once, store hash, scopes, per-key rate limit, last-used), RBAC, CSRF for cookie-auth non-Server-Action routes: **UNVERIFIED in this session** (general OWASP knowledge; I did not fetch ASVS/Supabase MFA pages). Verify at https://cheatsheetseries.owasp.org/ (Session Management, CSRF, Forgot Password, REST Security) and https://supabase.com/docs/guides/auth/auth-mfa.

### Risk
Auth bypass on self-hosted Next < 15.2.3; trusting a forged cookie via `getSession()`; IDOR through Server Actions; open redirect after login; invite-token theft from DB leak.

### How to implement here
- Pin `next >= 15.2.3` (check current latest 15.x patch for later advisories - UNVERIFIED). If self-hosting, strip `x-middleware-subrequest` at reverse proxy.
- `lib/auth/session.ts` (server-only): `requireUser()` calls `supabase.auth.getUser()` (or `getClaims()`), `requireMembership(orgId, minRole)` loads membership from DB (never from client/JWT user_metadata, which is user-editable - UNVERIFIED but standard Supabase caveat). Call from every `route.ts`, server action and DAL function; middleware only for redirects/UX.
- `middleware.ts`: copy the `@supabase/ssr` pattern; do not add DB calls; matcher excludes `/api/webhooks/*`, `/api/inngest`, `/u/*` (public).
- Open-redirect guard `lib/auth/safeRedirect.ts`: accept only paths beginning with a single `/` (not `//`, not `/\`), else default `/dashboard`. Apply to `/auth/callback?next=`.
- API keys: `omr_live_<8-char id>_<32+ bytes base64url>`; table `ApiKey(id, tenantId, prefix, hash, scopes[], lastUsedAt, revokedAt, expiresAt)`; hash with SHA-256 (high-entropy secret so fast hash is acceptable - standard practice, UNVERIFIED here); look up by prefix then `timingSafeEqual`.
- Invites: `Invite(tokenHash, orgId, email, role, expiresAt, usedAt)`; on accept require authenticated user whose verified email matches.
- RBAC: central `can(role, action)` map (owner/admin/member/viewer); tests per route.
- CSRF: Server Actions get Origin check; for cookie-authenticated `route.ts` mutations check `Origin` header equals app origin and require JSON content-type; keep cookies `SameSite=Lax`.

Confidence: Supabase, CVE, Next data-security **Verified**; OAuth/session/MFA/API-key/invite/RBAC specifics **UNVERIFIED**.

---

## 4. Multi-tenant isolation with Prisma

### Best practice
- Prisma connects as a DB role (typically `postgres`/service) and **bypasses RLS** unless you connect as a non-bypass role (general Postgres/Supabase knowledge, UNVERIFIED here). Two layers:
  1. App layer: Prisma client extension using `query.$allModels.$allOperations` to inject `tenantId` into `where` (docs: https://www.prisma.io/docs/orm/prisma-client/client-extensions/query). Caveats from doc: example shows only `where` injection; `create` etc. need separate handling; raw queries have `model` undefined; the doc does not cover nested relation filters; cannot mutate `select/include`.
  2. DB layer: RLS with a per-request setting. `SET LOCAL` lasts until end of the current transaction and warns/no-ops outside a transaction (https://www.postgresql.org/docs/current/sql-set.html); `set_config(name, value, true)` is the function equivalent (doc points to section 9.28.1; signature not on the fetched page - UNVERIFIED but standard). This means you MUST run set_config and queries in one `$transaction` (pooled connections - pgbouncer transaction mode makes session-level SET unsafe).
- IDOR prevention: Next guide: check ownership not only authentication (https://nextjs.org/docs/app/guides/data-security); OWASP IDOR cheat sheet (linked from that guide).
- Tenant-scoped storage: Supabase Storage policies / path prefix `{tenantId}/...` with signed URLs - UNVERIFIED (not fetched).

### Risk
One missed `where: { tenantId }` leaks another customer's leads/messages; `findUnique({where:{id}})` is the classic IDOR; raw SQL and aggregates bypass extensions.

### How to implement here
- `lib/db.ts`: export `prismaBase` (internal, not importable outside `lib/db`) and `forTenant(tenantId)` returning `prismaBase.$extends(...)` that (a) injects `tenantId` into `where` for read/update/delete ops, (b) sets `data.tenantId` on create/createMany, (c) throws on `$queryRaw` unless via an approved helper. Convert `findUnique` to `findFirst` with tenant filter or add composite unique `(tenantId,id)`.
- Wrap the tenant client in `$transaction` that first runs `SELECT set_config('app.tenant_id', $1, true)`; add RLS policies `USING (tenant_id = current_setting('app.tenant_id')::uuid)` and `FORCE ROW LEVEL SECURITY`; run app as a non-superuser, non-BYPASSRLS role. Keep an explicit `adminDb` for Inngest/system jobs with audit.
- ESLint `no-restricted-imports` banning `@prisma/client` outside `lib/db`.
- Tests: for every model with `tenantId`, a vitest that seeds two tenants and asserts tenant B cannot read/update/delete A's rows through each DAL function and API route; also a schema-lint test that fails if a model lacks `tenantId` and is not on an allowlist.
- Inngest functions: pass `tenantId` in event data and construct `forTenant()` inside each step; never use ambient globals.

Confidence: extension and SET LOCAL **Verified** (with noted gaps); RLS-role specifics and storage **UNVERIFIED**.

---

## 5. Secrets and encryption

### Best practice (all UNVERIFIED this session - general practice; confirm with OWASP Cryptographic Storage + Secrets Management cheat sheets)
- Envelope encryption: per-record random 256-bit data key (DEK) encrypts the token with AES-256-GCM (12-byte random nonce, never reuse per key, store auth tag); DEK wrapped by a KEK held in KMS/env; store `{keyVersion, wrappedDek, iv, tag, ciphertext}`; rotation = new KEK version, re-wrap DEKs lazily.
- Bind ciphertext to tenant with AAD (`tenantId|purpose`).
- Never log tokens/Authorization headers; redact in logger; Meta access tokens and Razorpay secrets stored per-tenant encrypted only.
- Note: Next.js itself documents `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` must be set consistently across servers (Verified: https://nextjs.org/docs/app/guides/data-security).

### How to implement here
- `lib/crypto/envelope.ts` (server-only) with `encrypt(plaintext, aad)`/`decrypt`; `Integration(tenantId, provider, secretCiphertext, keyVersion)`; env `KEK_V1`, `KEK_CURRENT=1`; background Inngest job to re-wrap on rotation. Prefer a managed KMS if budget allows.
- Pino/winston redact paths: `req.headers.authorization`, `*.accessToken`, `*.apiKey`, `*.secret`, phone/email (mask).
- Public/anon Supabase key is public; the service-role key must never be `NEXT_PUBLIC_` (Verified principle: only `NEXT_PUBLIC_` vars reach browser, Next doc).

Confidence: **UNVERIFIED** (except Next env note).

---

## 6. Abuse, input, headers, logging

- Rate limiting: Next doc recommends rate limiting expensive operations (sending emails, writes) and points to its Backend-for-Frontend guide (Verified). Implementation (UNVERIFIED suggestion): Upstash Ratelimit or Postgres/Redis sliding window keyed by IP + account for login/forgot-password/OTP, `/u/[token]` unsubscribe, `/t/[id]` click/open tracking, public forms/webhook-in endpoints; return 429 with `Retry-After`.
- Open redirect on click-tracking/unsubscribe: never redirect to a raw URL param; look up destination by signed/opaque link id stored server-side, or HMAC-sign the target. Unsubscribe pages must work without login, token-based, idempotent.
- Input validation: validate every Server Action / route input with Zod; params in `[param]` folders are user input (Next doc, Verified).
- **CSV import injection** (OWASP https://community.owasp.org/attacks/CSV_Injection , Verified): cells starting with `= + - @ tab CR LF` (and full-width variants) can execute; on **export** prefix with `'` and quote, tab-prefix for Excel; quoting alone may be undone by Excel save/reopen; no universal fix, test in target apps. On **import**, treat as data only; normalise phones to E.164, strip control chars, cap rows/size, parse server-side in a worker. Leading `+` is legitimate in phone numbers - escape only on export, store raw.
- File upload: allowlist extension + sniffed MIME, size caps, store outside web root in a private bucket, random names, no inline serving of user HTML/SVG. UNVERIFIED (general).
- Headers: CSP in Next (nonce-based) per https://nextjs.org/docs/app/guides/content-security-policy (linked from Next guide; not fetched - UNVERIFIED details); HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `frame-ancestors 'none'` via `next.config.js headers()` - UNVERIFIED.
- Logging: structured, tenant-scoped, redact PII (phones, emails, message bodies) and secrets; retention policy aligned with DPDP erasure (section 7).
- Taint API (`experimental.taint`) and `server-only` imports prevent accidental secret leakage to client (Verified, Next doc).

Confidence: CSV and Next items **Verified**; rest **UNVERIFIED**.

---

## 7. Messaging compliance

### WhatsApp (Meta)
- 24h customer service window starts/refreshes when the user messages or calls; inside: free-form allowed; outside: approved **template** messages only; opt-in required regardless of window - https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages (**Verified**).
- Messaging limits: new portfolios start at 250 unique users / rolling 24h (business-initiated, outside windows), tiers 2,000 -> 10,000 -> 100,000 -> unlimited; set at **business portfolio** level (shared by all numbers); to reach 2,000: verify business or send to 2,000 unique users in 30 days with high-quality templates; auto-upgrade within 6h if >=50% of limit used in last 7 days with high quality; read via `whatsapp_business_manager_messaging_limit` (`messaging_limit_tier` deprecated) - https://developers.facebook.com/docs/whatsapp/messaging-limits (**Verified**). Quality rating scale definitions not on that page - **UNVERIFIED**; template categories are marketing/utility/authentication (page lists them). Template approval rules, pause/disable on low quality, opt-out handling per WhatsApp Business Policy (https://whatsappbusiness.com/policy/ - redirect not fetched) - **UNVERIFIED**.
- Implement: `Conversation.lastInboundAt` -> `canSendFreeform = now-lastInboundAt < 24h`; otherwise force template picker; `Contact.waOptIn {source, at, evidence}`; honour inbound "STOP" keywords -> set opt-out and suppress; subscribe to quality/limit webhook updates and throttle campaign scheduling to the current tier (Inngest concurrency/throttle).

### TRAI (India)
- Framework: TCCCPR 2018 (notified 19 Jul 2018), DLT registration of entity/header/template, DND preferences, consent revocation mechanism (search summary; primary text https://bsnl.co.in:443/opencms/export/finresult/TCCCPR_2018.pdf not fetched) - partially **UNVERIFIED**.
- Vendor guide (Exotel, secondary source, https://developer.exotel.com/docs/faqs/trai-regulations): promotional calls/SMS limited to **9 AM-9 PM IST**, transactional/service 24/7; promotional blocked to DND numbers; all commercial SMS via DLT (Entity ID, Sender ID, Template ID); explicit consent with record for promotional; honour opt-outs within 7 days. **Treat as UNVERIFIED against primary TRAI text** - my search did not confirm the 9-9 window from a primary source. Penalty figures (INR 1,000 etc.) also UNVERIFIED. Feb 2025 TRAI amendment re telemarketers using 10-digit numbers and Oct 2024 calling-to-DLT move reported by secondary sources only.
- Implement: per-contact `timezone` default Asia/Kolkata; `isPromotional` flag on campaigns; scheduler blocks promotional voice/SMS outside 09:00-21:00 IST (config constant, so it can be changed once legal confirms); DND scrub field + provider NDNC check; store DLT template ID on each SMS template; keep consent ledger.

### DPDP Act 2023 / Rules 2025
- Rules notified 13/14 Nov 2025 (sources disagree on date); Rules 1,2,17-21 immediate; Rule 4 (Consent Manager registration) one year after (i.e. ~now, Nov 2026); Rules 3, 5-16, 22, 23 at 18 months (~13/14 May 2027) - secondary sources (e.g. https://www.mondaq.com/india/data-protection/1708164/digital-personal-data-protection-rules-2025-notified ; PIB PDF https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf) - **UNVERIFIED against Gazette**. Retention/erasure specifics not confirmed - read the Gazette text.
- Implement (design now, finalise with counsel): consent record per purpose with notice version, timestamp, channel; withdrawal as easy as giving; per-tenant erasure job (`Contact` hard-delete + message bodies + provider-side deletion where possible) via Inngest; data-processor agreement terms since customers are fiduciaries and OmniReach likely a processor (UNVERIFIED legal characterisation); breach-incident runbook; audit log of access/erasure.

### Email (Gmail/Yahoo bulk-sender rules)
- Gmail (>5,000 msgs/day): SPF + DKIM (>=1024-bit, 2048 recommended) + DMARC (p=none ok), PTR/forward-reverse DNS, TLS, RFC 5322, From-domain alignment, spam rate under 0.30% (aim <0.10%); marketing mail needs **one-click unsubscribe** headers `List-Unsubscribe: <https://...>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 2369/8058) plus visible body link; unsubscribe arrives as POST - https://support.google.com/a/answer/81126 (**Verified**). The "honour within 2 days" and Yahoo specifics and CAN-SPAM terms (physical address, 10 business days) are **UNVERIFIED** here (Gmail page did not state the 2-day rule).
- Implement: `POST /api/unsubscribe/[token]` handles one-click (no auth, no redirect, 200), `GET` renders confirm page; add both headers via Resend `headers` option on every marketing send (header passing in Resend API - UNVERIFIED); per-tenant sending domain with DKIM; suppression list on bounce/complaint webhooks (Resend event names not confirmed on fetched page - UNVERIFIED); per-tenant spam-rate monitoring and auto-pause.

---

## Prioritised checklist

### P0 (before any real customer data / sending)
1. Pin Next.js >= 15.2.3 (latest patch); strip `x-middleware-subrequest` at proxy if self-hosted; re-check auth in every route/action/DAL (not middleware only).
2. Use `getUser()`/`getClaims()`, never `getSession()`, for server authz.
3. Tenant isolation: `forTenant()` Prisma extension + ban raw prisma import + cross-tenant tests; ownership checks on every id lookup.
4. All webhook routes: raw-body HMAC verify, constant-time compare, dedup table, 200-fast then Inngest; Meta App Secret verify; per-tenant secret lookup for Typeform/Shopify/Woo.
5. Encrypt per-tenant provider tokens (AES-256-GCM envelope); redact secrets/PII in logs.
6. Opt-in/opt-out ledger; WhatsApp 24h window enforcement + template-only outside; STOP handling; suppression lists.
7. One-click unsubscribe headers + endpoint; SPF/DKIM/DMARC per sending domain.
8. Promotional voice/SMS time-window guard + DND scrub (confirm hours with counsel/primary TRAI text).

### P1
9. RLS as second layer with `set_config(...,true)` in transactions and non-bypass role.
10. Rate limiting on login, unsubscribe/track, public forms; open-redirect-safe tracking links and `next=` handling.
11. API keys (hashed, prefixed, scoped, rate-limited), invite tokens (hashed, single-use), RBAC matrix + tests, MFA for owners/admins.
12. Outbound webhooks with HMAC signing, SSRF-safe fetch (DNS pinning, no redirects), retry + delivery log + auto-disable.
13. CSV import/export hardening; upload validation; CSP/HSTS headers.
14. Messaging-tier-aware campaign throttling; spam-rate/quality auto-pause.
15. Secret rotation (overlapping secrets) for webhooks and KEK versioning.

### P2
16. mTLS for Meta webhooks (optional per Meta doc), provider IP allowlists as extra layer.
17. DPDP erasure/export tooling, consent manager interoperability, retention schedules (verify Gazette text; deadlines ~May 2027).
18. Penetration test / ASVS L2 review; security headers audit; storage bucket policy tests.
19. Close all UNVERIFIED items above against primary sources (Vapi auth, Razorpay/Resend/Typeform retry, Inngest idempotency, TRAI primary text, WhatsApp policy, Yahoo/CAN-SPAM, Supabase MFA).
