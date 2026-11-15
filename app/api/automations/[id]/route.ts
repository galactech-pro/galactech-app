import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma, type Prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { AutomationGraph, getTrigger, validateGraph } from "@/lib/automation-graph";

type P = { id: string };

export const GET = withAuth<P>(async (_req, session, ctx) => {
  const { id } = await ctx.params;
  const row = await prisma.automations.findFirst({ where: { id, org_id: session.org_id } });
  if (!row) return fail("Automation not found", 404);
  return ok(row);
});

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  steps: AutomationGraph.optional(),
});

export const PATCH = withAuth<P>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    const body = await parseBody(req, PatchSchema);
    const existing = await prisma.automations.findFirst({ where: { id, org_id: session.org_id } });
    if (!existing) return fail("Automation not found", 404);

    const data: Prisma.automationsUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description;
    if (body.steps) {
      const v = validateGraph(body.steps, { allowEmpty: !existing.is_active });
      if (!v.valid) return fail(v.errors.join("; "), 422);
      const trig = getTrigger(body.steps);
      data.steps = body.steps as unknown as Prisma.InputJsonValue;
      if (trig) {
        data.trigger_type = trig.trigger_type;
        data.trigger_config = trig.config as Prisma.InputJsonValue;
      }
    }
    const row = await prisma.automations.update({ where: { id, org_id: session.org_id }, data });
    await audit(session, "automation.update", "automation", id);
    return ok(row);
  },
  { role: "member" }
);

export const DELETE = withAuth<P>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    const existing = await prisma.automations.findFirst({ where: { id, org_id: session.org_id } });
    if (!existing) return fail("Automation not found", 404);
    await prisma.automations.delete({ where: { id, org_id: session.org_id } });
    await audit(session, "automation.delete", "automation", id, { before: { name: existing.name } });
    return ok({ id });
  },
  { role: "admin" }
);
