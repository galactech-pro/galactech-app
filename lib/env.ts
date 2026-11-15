/**
 * Central environment helpers. Import these instead of re-implementing `process.env.X ?? "http://localhost:3000"`
 * (audit M-16: a silent localhost fallback in production yields dead unsubscribe links / webhook URLs).
 */

/** Public base URL of the app, no trailing slash. Throws in production when NEXT_PUBLIC_APP_URL is unset. */
export function appUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (raw) return raw.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_APP_URL is not set. Set it to the public https URL of this deployment.");
  }
  return "http://localhost:3000";
}

/** Returns the env var or throws a clear error. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
