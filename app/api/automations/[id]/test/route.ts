import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendEvent } from "@/lib/inngest";
import { AutomationGraph, validateGraph } from "@/lib/automation-graph";

const Schema = z.object({ contact_id: z.string().uuid() });

/**
 * Test run: validates the graph and triggers the engine for ONE contact (real sends happen,
 * so pick your own test contact). Works on inactive automations too.
 */
export const POST = withAuth<{ id: string }>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    const { contact_id } = await parseBody(req, Schema);
    const a = await prisma.automations.findFirst({ where: { id, org_id: session.org_id } });
    if (!a) return fail("Automation not found", 404);
    const contact = await prisma.contacts.findFirst({ where: { id: contact_id, org_id: session.org_id, is_active: true } });
    if (!contact) return fail("Contact not found", 404);
    const graph = AutomationGraph.safeParse(a.steps);
    if (!graph.success) return fail("Automation graph is invalid", 422);
    const v = validateGraph(graph.data);
    if (!v.valid) return fail(v.errors.join("; "), 422);
    await sendEvent("automation/trigger", { org_id: session.org_id, automation_id: id, contact_id, test: true });
    await audit(session, "automation.test", "automation", id, { after: { contact_id } });
    return ok({ queued: true, note: "Test run queued; check automation analytics for progress." });
  },
  { role: "member" }
);
