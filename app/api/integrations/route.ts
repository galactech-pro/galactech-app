import { randomBytes } from "node:crypto";
import { z } from "zod";
import { withAuth, ok, parseBody, parseQuery, fail } from "@/lib/api";
import { prisma, type Prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { appUrl } from "@/lib/env";

const PROVIDERS = ["google_sheets", "zoho", "shopify", "woocommerce", "calendly", "typeform"] as const;
type Provider = (typeof PROVIDERS)[number];
/** Providers that push data to us via a per-org signed webhook URL. */
const INBOUND = ["typeform", "shopify", "woocommerce"] as const;
const isInbound = (p: Provider): p is (typeof INBOUND)[number] => (INBOUND as readonly string[]).includes(p);

const webhookUrl = (p: Provider, orgId: string) =>
  `${appUrl()}/api/integrations/webhook/${p}/${orgId}`;

function readConfig(enc: string): Record<string, unknown> {
  try {
    return JSON.parse(decrypt(enc)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const GET = withAuth(async (_req, session) => {
  const rows = await prisma.integrations.findMany({ where: { org_id: session.org_id } });
  return ok(
    PROVIDERS.map((p) => {
      const row = rows.find((r) => r.provider === p);
      return {
        provider: p,
        connected: !!row && row.is_active,
        is_active: row?.is_active ?? false,
        last_sync_at: row?.last_sync_at ?? null,
        mode: isInbound(p) ? "inbound_webhook" : "connect_only",
        webhook_url: isInbound(p) ? webhookUrl(p, session.org_id) : null,
        config_keys: row ? Object.keys(readConfig(row.config)).filter((k) => k !== "secret") : [],
      };
    })
  );
});

const Connect = z.object({
  provider: z.enum(PROVIDERS),
  config: z.record(z.unknown()).default({}),
});

/**
 * Connect/replace. Inbound providers (typeform/shopify/woocommerce) get a generated signing secret that is
 * returned ONCE here (paste it into the provider's webhook settings) along with the webhook_url.
 */
export const POST = withAuth(
  async (req, session) => {
    const b = await parseBody(req, Connect);
    const config: Record<string, unknown> = { ...b.config };
    let secret: string | undefined;
    if (isInbound(b.provider)) {
      secret = randomBytes(24).toString("hex");
      config.secret = secret;
    }
    const enc = encrypt(JSON.stringify(config));
    await prisma.integrations.upsert({
      where: { org_id_provider: { org_id: session.org_id, provider: b.provider } },
      create: { org_id: session.org_id, provider: b.provider, config: enc, is_active: true },
      update: { config: enc, is_active: true },
    });
    await audit(session, "integration.connect", "integration", b.provider, { after: { provider: b.provider } as Prisma.InputJsonValue });
    return ok(
      {
        provider: b.provider,
        connected: true,
        mode: isInbound(b.provider) ? "inbound_webhook" : "connect_only",
        webhook_url: isInbound(b.provider) ? webhookUrl(b.provider, session.org_id) : null,
        webhook_secret: secret ?? null,
      },
      201
    );
  },
  { role: "admin" }
);

/** DELETE /api/integrations?provider=… */
export const DELETE = withAuth(
  async (req, session) => {
    const { provider } = parseQuery(req, z.object({ provider: z.enum(PROVIDERS) }));
    const r = await prisma.integrations.deleteMany({ where: { org_id: session.org_id, provider } });
    if (!r.count) return fail("Integration not connected", 404);
    await audit(session, "integration.disconnect", "integration", provider);
    return ok({ provider });
  },
  { role: "admin" }
);
