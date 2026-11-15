import { ApiError } from "@/lib/api";
import { ComplianceError } from "@/lib/compliance";
import { OutboundError } from "./types";

/**
 * Map pipeline errors to ApiError so legacy callers (routes, inngest helpers) that only know ApiError / PlanLimitError
 * keep working. PlanLimitError and unknown errors are returned untouched.
 */
export function toApiError(e: unknown, label = "Send"): unknown {
  if (e instanceof ComplianceError) return new ApiError(422, e.message, e.code);
  if (e instanceof OutboundError) {
    const status = e.code === "PROVIDER_REJECTED" ? 502 : e.code === "CHANNEL_NOT_CONNECTED" ? 400 : 422;
    return new ApiError(status, e.code === "PROVIDER_REJECTED" ? `${label} failed: ${e.message}` : e.message, e.code);
  }
  return e;
}
