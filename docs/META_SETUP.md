# Getting Meta access (WhatsApp, Instagram, Messenger)

Status: steps marked ✅ were confirmed against Meta's [Get Started guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started). Steps marked ⚠️ are from memory or third-party guides. Check them in the Meta dashboard, because the UI and review rules change.

## Two paths. Pick one first.

| | A. Your own business only (MVP, pilot) | B. Platform for other businesses (SaaS launch) |
|---|---|---|
| Who sends | Your own WhatsApp number | Each customer's number |
| App Review | ⚠️ Usually not needed for your own assets | ⚠️ Required (Advanced Access) |
| Business Verification | ⚠️ Needed for higher message limits and display name approval | ⚠️ Required |
| Onboarding UX | You paste a token once | ⚠️ Embedded Signup (Tech Provider program) |
| Time | Hours to days | ⚠️ Weeks |

**Start with A.** The app already stores a per-org token and phone number id, so Path A works today. Move to B once you have paying customers.

## Path A: step by step

1. ✅ Create a Meta developer account at developers.facebook.com and a **Business**-type app.
2. ✅ Add the **WhatsApp** product to the app. Meta creates a test number and a test WhatsApp Business Account (WABA).
3. ✅ In API Setup, add up to a handful of recipient numbers (⚠️ limit was 5) and send the `hello_world` template. The temporary token on that page expires in about 24 hours, so don't use it for the app.
4. ✅ Create a **permanent token**: Meta Business Settings → Users → **System users** → add a system user (Admin) → assign your app and the WABA with full control → Generate token with `whatsapp_business_messaging` and `whatsapp_business_management` (⚠️ plus `business_management` in some guides). Expiry: Never.
5. Put the values into the app: `/channels` → WhatsApp (or `.env`):
   - Phone number ID → `wa_phone_number_id` (API Setup page)
   - Token → stored encrypted per org
   - App Secret (App settings → Basic) → `WA_APP_SECRET`
   - Any random string → `WA_WEBHOOK_VERIFY_TOKEN`
6. ✅ Configure the webhook (WhatsApp → Configuration): Callback URL `https://<your-domain>/api/webhooks/whatsapp`, Verify token = `WA_WEBHOOK_VERIFY_TOKEN`, subscribe to the **messages** field. The URL must be public HTTPS. For local dev use a tunnel (ngrok or cloudflared).
7. ⚠️ Add your own real number and a payment method, then complete **Business Verification** (Business Settings → Security Center). This raises the messaging limit and is needed for an approved display name.
8. **Templates**: messages outside the 24-hour customer window must use a pre-approved template. Create templates in WhatsApp Manager (⚠️ Marketing, Utility, Authentication categories; approval usually minutes to hours).

## Instagram and Messenger (same Meta app)

- Add the **Messenger** and **Instagram** products to the same app.
- Instagram needs an **Instagram Professional (Business or Creator) account linked to a Facebook Page**. ⚠️ Permissions: `instagram_business_basic`, `instagram_business_manage_messages`. Messenger: `pages_messaging`, `pages_manage_metadata`.
- ⚠️ In **Development mode** these work for people who have a role on the app (admin, developer, tester). Messaging real customers needs **App Review** for each permission (screencast of the use case, privacy policy URL, business verification). The app already serves `/privacy` and `/terms`.
- Webhook URL for both: `https://<your-domain>/api/webhooks/meta`, using `META_APP_SECRET` for signature verification. ⚠️ Instagram and Messenger share the app secret, and the verify token is the same handshake.
- ⚠️ Replies are limited to a window after the user's last message (24 hours standard; the 7-day human-agent tag is NOT implemented, see OPEN_QUESTIONS).

## Telegram (no approval needed)

Message @BotFather → `/newbot` → copy the token → paste it at `/channels` → Telegram. The app registers the webhook (`/api/webhooks/telegram/<token>`) with a secret header.

## Email

Resend: verify your sending domain (SPF + DKIM + DMARC DNS records), set `RESEND_API_KEY` and `EMAIL_FROM`. ⚠️ Gmail/Yahoo bulk-sender rules require one-click unsubscribe (already implemented at `/api/email/unsubscribe`).

## India-specific (⚠️ all UNVERIFIED, see docs/OPEN_QUESTIONS.md)

- Meta charges per conversation/template message category. Check the current India price list before you set plan prices.
- SMS via Twilio to Indian numbers needs DLT registration.
- Outbound AI voice has TRAI and DPDP implications. Get legal advice before enabling auto-calling.

## Checklist before real customers

- [ ] Permanent token created and not logged anywhere
- [ ] Webhook verified and receiving a test message (check the `webhook_events` table)
- [ ] STOP reply works end to end
- [ ] Business Verification submitted
- [ ] Template(s) approved
- [ ] Privacy policy URL live
