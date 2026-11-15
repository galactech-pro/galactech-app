import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma, type Prisma } from "@/lib/db";
import { checkLimit } from "@/lib/limits";
import { audit } from "@/lib/audit";
import { AUTOMATION_TEMPLATES, getTemplate } from "@/lib/templates/automation-templates";

export const GET = withAuth(async () => ok(AUTOMATION_TEMPLATES));

const Schema = z.object({ key: z.string().min(1), name: z.string().min(1).max(120).optional() });

/** Instantiate a template as a new (inactive) automation. */
export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, Schema);
    const t = getTemplate(body.key);
    if (!t) return fail("Template not found", 404);
    await checkLimit(session.org_id, "automations");
    const trigger = t.graph.nodes.find((n) => n.type === "trigger");
    const row = await prisma.automations.create({
      data: {
        org_id: session.org_id,
        name: body.name ?? t.name,
        description: t.description,
        trigger_type: t.trigger_type,
        trigger_config: (trigger && trigger.type === "trigger" ? trigger.data.config : {}) as Prisma.InputJsonValue,
        steps: t.graph as unknown as Prisma.InputJsonValue,
        is_active: false,
        created_by: session.user.id,
      },
    });
    await audit(session, "automation.create_from_template", "automation", row.id, { after: { template: t.key } });
    return ok(row, 201);
  },
  { role: "member" }
);
