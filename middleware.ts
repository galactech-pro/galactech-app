import { NextResponse, type NextRequest } from "next/server";

const PROTECTED = [
  "/dashboard", "/contacts", "/campaigns", "/automations", "/inbox", "/voice",
  "/analytics", "/channels", "/drafts", "/knowledge", "/deals", "/tasks", "/team", "/integrations", "/settings", "/billing", "/onboarding",
];

export async function middleware(request: NextRequest) {
  // Defence in depth for CVE-2025-29927 (x-middleware-subrequest bypass). Fixed in Next >= 15.2.3 (we run 15.5.x); this
  // check only runs on a patched runtime, so it is NOT a substitute for upgrading. Browsers never send this header.
  // Authorisation never depends on middleware: every route handler authenticates itself (withAuth / signature / API key).
  if (request.headers.has("x-middleware-subrequest")) {
    return new NextResponse("Bad request", { status: 400 });
  }
  // Cookie PRESENCE only (the Edge runtime cannot query the DB). The server layout and every API route validate the
  // session for real via getSession()/withAuth, so a forged cookie gets a redirect loop at worst, never data.
  const hasSession = request.cookies.has("omni_session");
  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED.some((p) => path === p || path.startsWith(p + "/"));

  if (isProtected && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

// API routes do their own auth via withAuth()/webhook signature checks.
export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] };
