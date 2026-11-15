import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { AutomationGraph, validateGraph } from "@/lib/automation-graph";

const Schema = z.object({ is_active: z.boolean().optional() });

export const PATCH = withAuth<{ id: string }>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    const body = await parseBody(req, Schema).catch(() => ({ is_active: undefined }));
    const existing = await prisma.automations.findFirst({ where: { id, org_id: session.org_id } });
    if (!existing) return fail("Automation not found", 404);
    const next = body.is_active ?? !existing.is_active;
    if (next) {
      const parsed = AutomationGraph.safeParse(existing.steps);
      if (!parsed.success) return fail("Automation graph is invalid", 422);
      const v = validateGraph(parsed.data);
      if (!v.valid) return fail(`Cannot activate: ${v.errors.join("; ")}`, 422);
    }
    const row = await prisma.automations.update({ where: { id, org_id: session.org_id }, data: { is_active: next } });
    await audit(session, next ? "automation.activate" : "automation.deactivate", "automation", id);
    return ok(row);
  },
  { role: "member" }
);
