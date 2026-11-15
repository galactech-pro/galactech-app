import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma, type Prisma } from "@/lib/db";
import { checkLimit } from "@/lib/limits";
import { audit } from "@/lib/audit";
import { AutomationGraph, TRIGGER_TYPES, getTrigger, validateGraph } from "@/lib/automation-graph";

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  trigger_type: z.enum(TRIGGER_TYPES).optional(),
  trigger_config: z.record(z.unknown()).optional(),
  steps: AutomationGraph.default({ nodes: [], edges: [] }),
});

export const GET = withAuth(async (_req, session) => {
  const rows = await prisma.automations.findMany({
    where: { org_id: session.org_id },
    orderBy: { created_at: "desc" },
  });
  return ok(rows);
});

export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, CreateSchema);
    await checkLimit(session.org_id, "automations");
    const empty = body.steps.nodes.length === 0;
    const v = validateGraph(body.steps, { allowEmpty: true });
    if (!v.valid) return fail(v.errors.join("; "), 422);
    const trig = getTrigger(body.steps);
    const trigger_type = trig?.trigger_type ?? body.trigger_type ?? "new_contact";
    const row = await prisma.automations.create({
      data: {
        org_id: session.org_id,
        name: body.name,
        description: body.description,
        trigger_type,
        trigger_config: (trig?.config ?? body.trigger_config ?? {}) as Prisma.InputJsonValue,
        steps: body.steps as unknown as Prisma.InputJsonValue,
        is_active: false,
        created_by: session.user.id,
      },
    });
    await audit(session, "automation.create", "automation", row.id, { after: { name: row.name, empty } });
    return ok(row, 201);
  },
  { role: "member" }
);
