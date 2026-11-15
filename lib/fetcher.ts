import type { ApiResponse } from "@/lib/api";

export class FetchError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

/** Client-side helper: unwraps { success, data, error }. Throws FetchError (code "PLAN_LIMIT" → show upgrade modal). */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = (await res.json().catch(() => null)) as (ApiResponse<T> & { code?: string }) | null;
  if (!res.ok || !body?.success) throw new FetchError(body?.error ?? res.statusText, res.status, body?.code);
  return body.data as T;
}
