import { createHash } from "node:crypto";
import type { ZodType, ZodTypeDef } from "zod";
import { prisma, type Prisma } from "@/lib/db";
import { isTrialExpired } from "@/lib/limits";
import { AiError, callModel, stripFences } from "./llm";
import { buildPrompt } from "./guards";

/** Output failed Zod / semantic validation twice. FAIL CLOSED: callers must not send anything. */
export class AiValidationError extends AiError {
  name = "AiValidationError";
  constructor(message: string, public issues: string[] = []) {
    super(message);
  }
}

/** Per-org daily cap reached (M-07 / LLM10). */
export class AiLimitError extends AiError {
  name = "AiLimitError";
}

const envInt = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};

export interface RunStructuredOpts<T> {
  /** e.g. "generate_message", "score_adjust". Stored in ai_runs.kind and used for the daily cap. */
  kind: string;
  orgId?: string | null;
  schema: ZodType<T, ZodTypeDef, unknown>;
  /** Role + rules + output contract. Trusted. */
  system: string;
  /** The task and the exact JSON shape wanted. Trusted. */
  task: string;
  /** Facts the model may state (org config, user goal, approved offers). JSON-encoded, never concatenated. */
  trusted?: unknown;
  /** Customer / CRM / transcript text. JSON-encoded inside a delimited block the model is told never to obey. */
  untrusted?: unknown;
  provider?: "gemini" | "claude";
  temperature?: number;
  maxTokens?: number;
  promptVersion?: string;
  /** Semantic checks beyond the schema (grounding, length...). Returns problem strings; non-empty triggers repair. */
  check?: (out: T) => string[];
}

async function logRun(orgId: string | null | undefined, r: { kind: string; model: string; promptVersion: string; hash: string; output?: unknown; valid: boolean; error?: string; ms: number }) {
  if (!orgId) return;
  try {
    await prisma.ai_runs.create({
      data: {
        org_id: orgId,
        kind: r.kind,
        model: r.model,
        prompt_version: r.promptVersion,
        input_hash: r.hash,
        output: r.valid && r.output !== undefined ? (r.output as Prisma.InputJsonValue) : undefined,
        valid: r.valid,
        error: r.error?.slice(0, 500),
        latency_ms: r.ms,
      },
    });
  } catch (e) {
    console.error("[ai] could not log ai_run", e);
  }
}

async function assertUnderDailyCap(orgId: string) {
  if (await isTrialExpired(orgId)) throw new AiLimitError("Your trial has ended. Upgrade to keep using AI features."); // M-07
  const cap = envInt("AI_DAILY_RUN_CAP", 500);
  if (cap === 0) return;
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const used = await prisma.ai_runs.count({ where: { org_id: orgId, created_at: { gte: since } } });
  if (used >= cap) throw new AiLimitError(`Daily AI limit reached (${cap} requests per 24h). Try again later.`);
}

/**
 * THE single entry point for every LLM call in the product.
 *  1. system rules + delimited TRUSTED / UNTRUSTED JSON blocks (never string-concatenated data)
 *  2. provider JSON mode, then ALWAYS Zod-validate (+ optional semantic `check`)
 *  3. one repair retry with the validation errors, then throw AiValidationError (fail closed)
 *  4. every attempt logged to ai_runs (input hash only, no raw prompt)
 *  5. timeout (AI_TIMEOUT_MS), max tokens (AI_MAX_OUTPUT_TOKENS) and per-org daily cap (AI_DAILY_RUN_CAP, 0 = off)
 */
export async function runStructured<T>(o: RunStructuredOpts<T>): Promise<T> {
  if (o.orgId) await assertUnderDailyCap(o.orgId);
  const { system, user } = buildPrompt(o);
  const hash = createHash("sha256").update(system).update("\u0000").update(user).digest("hex");
  const promptVersion = o.promptVersion ?? "v1";
  const timeoutMs = envInt("AI_TIMEOUT_MS", 30_000);
  const tokenCap = envInt("AI_MAX_OUTPUT_TOKENS", 1500) || 1500;
  const maxTokens = Math.min(o.maxTokens ?? tokenCap, tokenCap);

  let repair: { previous: string; instruction: string } | undefined;
  let lastIssues: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    let model = o.provider ?? "gemini";
    let text = "";
    try {
      const res = await callModel({
        provider: o.provider ?? "gemini",
        system,
        user,
        repair,
        temperature: o.temperature ?? 0.2,
        maxTokens,
        timeoutMs,
        json: true,
      });
      model = res.model as typeof model;
      text = res.text;
    } catch (e) {
      await logRun(o.orgId, { kind: o.kind, model, promptVersion, hash, valid: false, error: e instanceof Error ? e.message : "provider error", ms: Date.now() - t0 });
      throw e;
    }

    let issues: string[] = [];
    let parsed: T | undefined;
    try {
      const json: unknown = JSON.parse(stripFences(text));
      const r = o.schema.safeParse(json);
      if (r.success) {
        const semantic = o.check?.(r.data) ?? [];
        if (semantic.length) issues = semantic;
        else parsed = r.data;
      } else {
        issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      }
    } catch {
      issues = ["output was not valid JSON"];
    }

    await logRun(o.orgId, {
      kind: o.kind,
      model,
      promptVersion,
      hash,
      output: parsed,
      valid: parsed !== undefined,
      error: issues.join(" | "),
      ms: Date.now() - t0,
    });
    if (parsed !== undefined) return parsed;

    lastIssues = issues;
    repair = {
      previous: text.slice(0, 4000),
      instruction: `Your previous JSON was rejected: ${issues.join("; ")}. Return corrected JSON only. Fix every listed problem; do not add facts that are not in TRUSTED_FACTS.`,
    };
  }
  throw new AiValidationError("AI returned output that failed validation. Nothing was sent.", lastIssues);
}
