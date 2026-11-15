import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { verifyUnsubscribeToken } from "@/lib/email";
import { clientIp, limitOrResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head><body style="font-family:Inter,Arial,sans-serif;background:#000;color:#ccc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="background:#111;border:1px solid #333;padding:32px;border-radius:8px;max-width:420px;text-align:center"><h2 style="margin-top:0;color:#fff">${esc(title)}</h2>${body}</div></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function unsubscribe(token: string | null): Promise<boolean> {
  if (!token) return false;
  const contactId = verifyUnsubscribeToken(token);
  if (!contactId) return false;
  await prisma.contacts.updateMany({ where: { id: contactId }, data: { email_opt_out: true } }); // tenant-ok: id comes from an HMAC-signed token
  return true;
}

/**
 * GET only renders a confirmation page (audit L-05): link scanners / mail prefetchers issue GETs and must not
 * unsubscribe people. The state change happens on POST (the confirm button, or RFC 8058 one-click from the mail client).
 */
export async function GET(req: NextRequest) {
  const limited = await limitOrResponse(`unsub:${clientIp(req)}`, { limit: 30, windowSec: 60 });
  if (limited) return limited;
  const token = req.nextUrl.searchParams.get("t");
  if (!token || !verifyUnsubscribeToken(token)) return page("Invalid link", `<p style="color:#ccc">This unsubscribe link is invalid or has expired.</p>`, 400);
  return page(
    "Unsubscribe from marketing emails?",
    `<form method="post" action="?t=${encodeURIComponent(token)}"><input type="hidden" name="confirm" value="1"><button type="submit" style="background:#00C16A;color:#000;border:0;border-radius:6px;padding:11px 20px;font-size:14px;font-weight:600;cursor:pointer">Yes, unsubscribe me</button></form>`
  );
}

/** Confirm-button submit (form field confirm=1 -> HTML page) or RFC 8058 one-click (JSON). */
export async function POST(req: NextRequest) {
  const limited = await limitOrResponse(`unsub:${clientIp(req)}`, { limit: 30, windowSec: 60 });
  if (limited) return limited;
  const done = await unsubscribe(req.nextUrl.searchParams.get("t"));
  const form = await req.formData().catch(() => null);
  if (form?.get("confirm") === "1") {
    return done
      ? page("You're unsubscribed", `<p style="color:#ccc">You will no longer receive marketing emails from this sender.</p>`)
      : page("Invalid link", `<p style="color:#ccc">This unsubscribe link is invalid or has expired.</p>`, 400);
  }
  return NextResponse.json({ success: done }, { status: done ? 200 : 400 });
}
