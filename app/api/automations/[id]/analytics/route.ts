import { withAuth, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/db";
import { AutomationGraph } from "@/lib/automation-graph";

/**
 * Per-step funnel from automation_runs. A run "reached" a step if its current_step is that step or a
 * step downstream of it (BFS over the graph); runs completed are counted as having reached every step
 * on their path, approximated by reachability from the last known step.
 */
export const GET = withAuth<{ id: string }>(async (_req, session, ctx) => {
  const { id } = await ctx.params;
  const a = await prisma.automations.findFirst({ where: { id, org_id: session.org_id } });
  if (!a) return fail("Automation not found", 404);
  const graph = AutomationGraph.safeParse(a.steps);
  if (!graph.success) return fail("Automation graph is invalid", 422);

  const runs = await prisma.automation_runs.findMany({
    where: { automation_id: id },
    select: { status: true, current_step: true },
  });
  const total = runs.length;
  const byStatus = { running: 0, completed: 0, failed: 0, stopped: 0 };
  const atStep = new Map<string, number>();
  for (const r of runs) {
    byStatus[r.status]++;
    if (r.current_step) atStep.set(r.current_step, (atStep.get(r.current_step) ?? 0) + 1);
  }

  // ancestors-of: reaching node X means the run passed through all nodes upstream
  const parents = new Map<string, string[]>();
  for (const e of graph.data.edges) (parents.get(e.target) ?? parents.set(e.target, []).get(e.target)!).push(e.source);
  const passedThrough = new Map<string, number>();
  for (const [step, count] of atStep) {
    const seen = new Set<string>();
    const stack = [step];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(parents.get(n) ?? []));
    }
    for (const n of seen) passedThrough.set(n, (passedThrough.get(n) ?? 0) + count);
  }

  const steps = graph.data.nodes.map((n) => {
    const reached = n.type === "trigger" ? total : passedThrough.get(n.id) ?? 0;
    return {
      node_id: n.id,
      type: n.type,
      label: n.type === "action" ? n.data.action : n.type === "trigger" ? n.data.trigger_type : n.type,
      contacts_reached: reached,
      currently_here: atStep.get(n.id) ?? 0,
      drop_off_pct: total ? Math.round(((total - reached) / total) * 1000) / 10 : 0,
    };
  });

  return ok({
    automation_id: id,
    run_count: a.run_count,
    last_run_at: a.last_run_at,
    total_runs: total,
    by_status: byStatus,
    completion_rate: total ? Math.round((byStatus.completed / total) * 1000) / 10 : 0,
    steps,
  });
});
