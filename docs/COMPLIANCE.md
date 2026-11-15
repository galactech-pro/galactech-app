# Compliance: consent sources

Legal characterisations below are UNVERIFIED policy choices, not statements of law (see docs/OPEN_QUESTIONS.md).

## Rule
An inbound message does NOT create marketing consent. It only opens the 24h customer-service window: `assertCanContact` already allows `purpose: "service"` replies without a consent row (hard opt-outs and DNC still block). `recordInboundConsent` (lib/compliance) is a no-op that returns false and is kept only so callers compile. Marketing (and automated follow-up templates) require a granted row in the `consents` ledger.

## Allowed consent sources (ledger `source`)
| Source | Function | When |
|---|---|---|
| `import_attested` | `applyImportConsent` (lib/compliance/import-consent.ts) | CSV import where the importer ticked the attestation; evidence keeps attester + time. Adequacy of bulk self-attestation is UNVERIFIED. |
| `form` (or integration name) | `recordFormConsent` | Public form / integration receiver (Typeform, Shopify...) captured an explicit opt-in. |
| explicit WhatsApp / website opt-in | `recordConsent(..., "granted", "<source>", evidence)` | Contact explicitly opted in via a keyword/button/web widget; evidence must record the capture. |
| manual / API entry | `recordConsent(..., "granted", "manual" \| "api", evidence)` | A user or API caller records consent they hold. |
| `stop_keyword` (revocation) | `applyStopKeyword` | STOP keyword; appends `revoked` rows (scope via `STOP_SCOPE`). |

The ledger is append-only; the latest row per contact and channel decides.
