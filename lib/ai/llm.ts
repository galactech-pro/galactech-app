import { GoogleGenerativeAI } from "@google/generative-ai";
import Anthropic from "@anthropic-ai/sdk";
import type { ZodType, ZodTypeDef } from "zod";

type Schema<T> = ZodType<T, ZodTypeDef, unknown>;

export class AiError extends Error {
  name = "AiError";
}

export function stripFences(raw: string): string {
  let t = raw.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m?.[1]) t = m[1].trim();
  if (!t.startsWith("{") && !t.startsWith("[")) {
    const s = t.search(/[{[]/);
    const e = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (s >= 0 && e > s) t = t.slice(s, e + 1);
  }
  return t;
}

function geminiModel(temperature: number, json: boolean) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new AiError("AI is not configured (GEMINI_API_KEY missing)");
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    generationConfig: { temperature, ...(json ? { responseMimeType: "application/json" } : {}) },
  });
}

export async function geminiText(prompt: string, temperature = 0.7): Promise<string> {
  try {
    const res = await geminiModel(temperature, false).generateContent(prompt);
    return res.response.text().trim();
  } catch (e) {
    if (e instanceof AiError) throw e;
    console.error("[ai] gemini error", e);
    throw new AiError("AI request failed. Please try again.");
  }
}

/** Ask Gemini for JSON, strip fences, validate with Zod. One retry on invalid output. */
export async function geminiJson<T>(prompt: string, schema: Schema<T>, temperature = 0.2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await geminiModel(temperature, true).generateContent(
        attempt === 0 ? prompt : `${prompt}\n\nReturn ONLY valid JSON matching the requested shape.`
      );
      return schema.parse(JSON.parse(stripFences(res.response.text())));
    } catch (e) {
      if (e instanceof AiError) throw e;
      lastErr = e;
    }
  }
  console.error("[ai] invalid model output", lastErr);
  throw new AiError("AI returned an unexpected response. Please try again.");
}

export interface CallModelOpts {
  provider: "gemini" | "claude";
  system: string;
  user: string;
  /** Extra turns used by the repair retry: previous model output + corrective instruction. */
  repair?: { previous: string; instruction: string };
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** Ask the provider for JSON (Gemini: responseMimeType). Schema constraints are still enforced by Zod, not the provider. */
  json: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new AiError(`AI request timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** One provider call with system/user separation, token cap and timeout. Returns raw text + the model id used. */
export async function callModel(o: CallModelOpts): Promise<{ text: string; model: string }> {
  if (o.provider === "claude" && hasAnthropic()) {
    const model = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: o.timeoutMs, maxRetries: 0 });
      const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: o.user }];
      if (o.repair) messages.push({ role: "assistant", content: o.repair.previous }, { role: "user", content: o.repair.instruction });
      const res = await withTimeout(
        client.messages.create({
          model,
          max_tokens: o.maxTokens,
          temperature: o.temperature,
          system: o.json ? `${o.system}\n\nRespond with ONLY a JSON object, no prose, no markdown.` : o.system,
          messages,
        }),
        o.timeoutMs
      );
      return { text: res.content.map((b) => (b.type === "text" ? b.text : "")).join(""), model };
    } catch (e) {
      if (e instanceof AiError) throw e;
      console.error("[ai] claude error, falling back to gemini", e);
    }
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new AiError("AI is not configured (GEMINI_API_KEY missing)");
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  try {
    const m = new GoogleGenerativeAI(key).getGenerativeModel(
      {
        model,
        systemInstruction: o.system,
        generationConfig: { temperature: o.temperature, maxOutputTokens: o.maxTokens, ...(o.json ? { responseMimeType: "application/json" } : {}) },
      },
      { timeout: o.timeoutMs }
    );
    const contents = [{ role: "user", parts: [{ text: o.user }] }];
    if (o.repair) {
      contents.push({ role: "model", parts: [{ text: o.repair.previous }] }, { role: "user", parts: [{ text: o.repair.instruction }] });
    }
    const res = await withTimeout(m.generateContent({ contents }), o.timeoutMs);
    return { text: res.response.text().trim(), model };
  } catch (e) {
    if (e instanceof AiError) throw e;
    console.error("[ai] gemini error", e);
    throw new AiError("AI request failed. Please try again.");
  }
}

export function hasAnthropic(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function claudeJson<T>(prompt: string, schema: Schema<T>, temperature = 0.7): Promise<T> {
  if (!hasAnthropic()) return geminiJson(prompt, schema, temperature);
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
      max_tokens: 2000,
      temperature,
      messages: [{ role: "user", content: `${prompt}\n\nRespond with ONLY a JSON object, no prose, no markdown.` }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return schema.parse(JSON.parse(stripFences(text)));
  } catch (e) {
    console.error("[ai] claude error, falling back to gemini", e);
    return geminiJson(prompt, schema, temperature);
  }
}
