import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest";
import { functions } from "@/inngest/functions";

export const runtime = "nodejs";
export const maxDuration = 60;

const handlers = serve({ client: inngest, functions });

/**
 * M-15: fail closed in production. Without INNGEST_SIGNING_KEY the serve handler would accept unsigned requests from
 * anyone, which lets an attacker invoke workflow functions directly. Dev is unaffected.
 */
function guarded<T extends (...a: never[]) => Promise<Response>>(h: T): T {
  return (async (...args: Parameters<T>) => {
    if (process.env.NODE_ENV === "production" && !process.env.INNGEST_SIGNING_KEY) {
      console.error("[inngest] INNGEST_SIGNING_KEY is not set in production; refusing to serve /api/inngest");
      return new Response(JSON.stringify({ error: "Inngest signing key not configured" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    return h(...args);
  }) as T;
}

export const GET = guarded(handlers.GET);
export const POST = guarded(handlers.POST);
export const PUT = guarded(handlers.PUT);
