import { resolveMx } from "node:dns/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { privateIp } from "@/lib/knowledge/crawl";

export interface MailboxSettings {
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
}

export interface Preset extends MailboxSettings {
  key: string;
  label: string;
  /** Where the customer creates the password the app uses. Shown in the UI. */
  help: string;
}

export const PRESETS: Record<string, Preset> = {
  gmail: {
    key: "gmail", label: "Gmail / Google Workspace", imap_host: "imap.gmail.com", imap_port: 993, smtp_host: "smtp.gmail.com", smtp_port: 465,
    help: "Google Account > Security > turn on 2-Step Verification > App passwords > create one named OmniReach. Paste the 16-letter password here (not your normal password).",
  },
  outlook: {
    key: "outlook", label: "Outlook / Microsoft 365", imap_host: "outlook.office365.com", imap_port: 993, smtp_host: "smtp.office365.com", smtp_port: 587,
    help: "Microsoft account > Security > Advanced security options > App passwords. Many Microsoft 365 work accounts block this; if connecting fails, ask your admin to enable IMAP and app passwords, or use forwarding instead.",
  },
  yahoo: {
    key: "yahoo", label: "Yahoo Mail", imap_host: "imap.mail.yahoo.com", imap_port: 993, smtp_host: "smtp.mail.yahoo.com", smtp_port: 465,
    help: "Yahoo Account Security > Generate app password.",
  },
  icloud: {
    key: "icloud", label: "iCloud Mail", imap_host: "imap.mail.me.com", imap_port: 993, smtp_host: "smtp.mail.me.com", smtp_port: 587,
    help: "appleid.apple.com > Sign-In and Security > App-Specific Passwords.",
  },
  zoho: {
    key: "zoho", label: "Zoho Mail", imap_host: "imap.zoho.com", imap_port: 993, smtp_host: "smtp.zoho.com", smtp_port: 465,
    help: "Zoho Accounts > Security > App Passwords. Also enable IMAP in Zoho Mail > Settings > Mail Accounts.",
  },
  zoho_in: {
    key: "zoho_in", label: "Zoho Mail (India)", imap_host: "imap.zoho.in", imap_port: 993, smtp_host: "smtp.zoho.in", smtp_port: 465,
    help: "Zoho Accounts > Security > App Passwords. Also enable IMAP in Zoho Mail > Settings > Mail Accounts.",
  },
  godaddy: {
    key: "godaddy", label: "GoDaddy Email", imap_host: "imap.secureserver.net", imap_port: 993, smtp_host: "smtpout.secureserver.net", smtp_port: 465,
    help: "Use your GoDaddy email address and its normal password. If it fails, turn IMAP on for the mailbox in your GoDaddy email settings.",
  },
  namecheap: {
    key: "namecheap", label: "Namecheap Private Email", imap_host: "mail.privateemail.com", imap_port: 993, smtp_host: "mail.privateemail.com", smtp_port: 465,
    help: "Use your mailbox address and password.",
  },
  hostinger: {
    key: "hostinger", label: "Hostinger Email", imap_host: "imap.hostinger.com", imap_port: 993, smtp_host: "smtp.hostinger.com", smtp_port: 465,
    help: "Use your mailbox address and password.",
  },
};

const DOMAIN_MAP: Record<string, string> = {
  "gmail.com": "gmail", "googlemail.com": "gmail",
  "outlook.com": "outlook", "hotmail.com": "outlook", "live.com": "outlook", "msn.com": "outlook",
  "yahoo.com": "yahoo", "ymail.com": "yahoo", "yahoo.in": "yahoo",
  "icloud.com": "icloud", "me.com": "icloud",
  "zoho.com": "zoho", "zoho.in": "zoho_in",
};

const MX_PATTERNS: [RegExp, string][] = [
  [/(^|\.)(google\.com|googlemail\.com)$/i, "gmail"],
  [/\.mail\.protection\.outlook\.com$/i, "outlook"],
  [/(^|\.)zoho\.in$/i, "zoho_in"],
  [/(^|\.)zoho\.(com|eu)$/i, "zoho"],
  [/(^|\.)secureserver\.net$/i, "godaddy"],
  [/(^|\.)(privateemail\.com|registrar-servers\.com)$/i, "namecheap"],
  [/(^|\.)(hostinger\.com|titan\.email)$/i, "hostinger"],
  [/(^|\.)yahoodns\.net$/i, "yahoo"],
];

/** Which provider hosts this address? Known domains first, then the domain's MX records (so custom domains on Google/Zoho/etc. are found). */
export async function detectPreset(email: string): Promise<Preset | null> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  const known = DOMAIN_MAP[domain];
  if (known) return PRESETS[known]!;
  try {
    const mx = await resolveMx(domain);
    for (const rec of mx.sort((a, b) => a.priority - b.priority)) for (const [re, key] of MX_PATTERNS) if (re.test(rec.exchange)) return PRESETS[key]!;
  } catch {
    /* no MX or DNS failure: ask the user for hosts */
  }
  return null;
}

export const ALLOWED_IMAP_PORTS = [993, 143];
export const ALLOWED_SMTP_PORTS = [465, 587, 2525];

/** Customers type these hostnames, so they must resolve to public addresses only (no internal network probing). */
export async function assertPublicHost(host: string): Promise<void> {
  const h = host.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h) || !h.includes(".")) throw new Error("That mail server address looks invalid");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) throw new Error("Private addresses are not allowed");
  const addrs = isIP(h) ? [{ address: h }] : await lookup(h, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`Could not find the mail server ${h}`);
  if (addrs.some((a) => privateIp(a.address))) throw new Error("Private addresses are not allowed");
}
