import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Normalise an Indian/intl phone number to E.164 (defaults to +91 for 10-digit numbers). */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  const only = digits.replace(/\D/g, "");
  if (only.length === 10) return `+91${only}`;
  if (only.length === 12 && only.startsWith("91")) return `+${only}`;
  if (only.length === 11 && only.startsWith("0")) return `+91${only.slice(1)}`;
  return null;
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

/** Replace {name}, {company}, ... merge tags. */
export function applyMergeTags(
  template: string,
  contact: { full_name: string; company?: string | null; email?: string | null; phone?: string | null }
): string {
  return template
    .replace(/\{name\}/gi, firstName(contact.full_name))
    .replace(/\{full_name\}/gi, contact.full_name)
    .replace(/\{company\}/gi, contact.company ?? "")
    .replace(/\{email\}/gi, contact.email ?? "")
    .replace(/\{phone\}/gi, contact.phone ?? "");
}
