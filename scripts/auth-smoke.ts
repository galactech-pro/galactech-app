/**
 * End-to-end auth smoke test against a RUNNING server (default http://localhost:3100).
 *   pnpm dev -p 3100   (other terminal)   then   pnpm smoke:auth
 * Creates throw-away accounts with a unique email prefix and deletes their organisations at the end (even on failure).
 * Uses a distinct fake X-Forwarded-For per scenario so the per-IP rate limits do not interfere between scenarios.
 * Requires the dev server to read the same DATABASE_URL as this script.
 */
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { pooledDatabaseUrl } from "../lib/db-url";
import { issueAuthToken } from "../lib/auth-tokens";

const BASE = (process.env.BASE_URL ?? "http://localhost:3100").replace(/\/+$/, "");
const prisma = new PrismaClient({ datasources: { db: { url: pooledDatabaseUrl() } } });
const RUN = `smoke-${Date.now().toString(36)}`;
const email = (n: string) => `${RUN}-${n}@example.test`;
const GOOD = "CorrectHorse9";
let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`);
  }
}

let ipCounter = 10;
const nextIp = () => `10.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}.${Math.floor(Math.random() * 200) + 1}`;

class Client {
  jar = new Map<string, string>();
  constructor(public ip = nextIp()) {}
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(BASE + path, {
      method,
      redirect: "manual",
      headers: { "x-forwarded-for": this.ip, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(this.jar.size ? { cookie: this.cookie() } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const val = pair.slice(i + 1);
      if (!val || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, val);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, headers: res.headers, text };
  }
  post(path: string, body: unknown, h?: Record<string, string>) {
    return this.req("POST", path, body, h);
  }
  get(path: string) {
    return this.req("GET", path);
  }
}

const signupBody = (n: string, extra: Record<string, unknown> = {}) => ({ full_name: "Smoke Tester", org_name: `Smoke Org ${n}`, email: email(n), password: GOOD, ...extra });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function main() {
  console.log(`auth smoke against ${BASE} (run ${RUN})`);
  const probe = await fetch(BASE + "/api/auth/me").catch(() => null);
  if (!probe) throw new Error(`server not reachable at ${BASE}`);

  console.log("\nSignup");
  {
    const c = new Client();
    const weak = await c.post("/api/auth/signup", signupBody("weak", { password: "short1" }));
    check("weak password rejected (422)", weak.status === 422, String(weak.status));
    const nodigit = await c.post("/api/auth/signup", signupBody("weak2", { password: "onlyletters" }));
    check("password without a digit rejected", nodigit.status === 422, String(nodigit.status));
    const noorg = await c.post("/api/auth/signup", signupBody("noorg", { org_name: "" }));
    check("missing business name rejected", noorg.status === 422, String(noorg.status));
    const bademail = await c.post("/api/auth/signup", signupBody("x", { email: "not-an-email" }));
    check("invalid email rejected", bademail.status === 422, String(bademail.status));

    const r = await c.post("/api/auth/signup", signupBody("a"));
    check("signup returns 201", r.status === 201, r.text.slice(0, 160));
    check("session cookie set (httpOnly)", c.jar.has("omni_session"));
    const rawSetCookie = r.headers.get("set-cookie") ?? "";
    check("cookie is HttpOnly + SameSite=Lax", /httponly/i.test(rawSetCookie) && /samesite=lax/i.test(rawSetCookie), rawSetCookie.replace(/omni_session=[^;]+/, "omni_session=<redacted>"));
    const me = await c.get("/api/auth/me");
    check("/api/auth/me returns owner", me.status === 200 && me.json?.data?.role === "owner" && me.json?.data?.email === email("a"), me.text.slice(0, 160));
    const u = await prisma.users.findUnique({ where: { email: email("a") }, include: { org: true } });
    check("org + owner row created, trial org on free plan", !!u && u.org.plan === "free" && !!u.org.trial_ends_at && u.role === "owner");
    check("password stored hashed (scrypt)", !!u?.password_hash?.startsWith("scrypt$") && !u.password_hash.includes(GOOD));
    const sub = u ? await prisma.subscriptions.findFirst({ where: { org_id: u.org_id } }) : null;
    check("trialing subscription created", sub?.status === "trialing");
    check("session stored hashed in DB", !!(await prisma.user_sessions.findFirst({ where: { token_hash: sha256(c.jar.get("omni_session") ?? "") } })));

    const dup = await new Client().post("/api/auth/signup", signupBody("a"));
    check("duplicate email -> 409", dup.status === 409, String(dup.status));
    const dupCase = await new Client().post("/api/auth/signup", signupBody("a", { email: email("a").toUpperCase() }));
    check("duplicate email is case-insensitive (UPPER) -> 409", dupCase.status === 409, String(dupCase.status));
    const login = new Client();
    const lc = await login.post("/api/auth/login", { email: email("a").toUpperCase(), password: GOOD });
    check("login with different email case works", lc.status === 200, String(lc.status));

    // concurrent duplicate signups: exactly one wins
    const em = { email: email("race") };
    const results = await Promise.all([1, 2, 3].map(() => new Client().post("/api/auth/signup", signupBody("race", em))));
    const codes = results.map((x) => x.status).sort();
    check("3 concurrent signups with same email: exactly one 201, rest 409", codes.filter((x) => x === 201).length === 1 && codes.filter((x) => x === 409).length === 2, codes.join(","));
    check("no 500s on the race", !codes.includes(500));
  }

  console.log("\nEmail verification");
  {
    const c = new Client();
    await c.post("/api/auth/signup", signupBody("ver"));
    const u = await prisma.users.findUniqueOrThrow({ where: { email: email("ver") } });
    // In dev without RESEND_API_KEY the user is auto-verified; reset the flag so we test the token path itself.
    await prisma.users.update({ where: { id: u.id }, data: { email_verified_at: null } });
    const t = await issueAuthToken(u.id, "verify_email");
    const r = await c.get(`/api/auth/verify?token=${encodeURIComponent(t)}`);
    check("verify link redirects to dashboard", r.status === 307 && (r.headers.get("location") ?? "").includes("/dashboard"), `${r.status} ${r.headers.get("location")}`);
    check("email_verified_at set", !!(await prisma.users.findUniqueOrThrow({ where: { id: u.id } })).email_verified_at);
    const again = await c.get(`/api/auth/verify?token=${encodeURIComponent(t)}`);
    check("verify token is single-use", (again.headers.get("location") ?? "").includes("/login?error="), String(again.headers.get("location")));
    const t2 = await issueAuthToken(u.id, "verify_email");
    await prisma.auth_tokens.updateMany({ where: { user_id: u.id, used_at: null }, data: { expires_at: new Date(Date.now() - 1000) } });
    const exp = await c.get(`/api/auth/verify?token=${encodeURIComponent(t2)}`);
    check("expired verify token rejected", (exp.headers.get("location") ?? "").includes("/login?error="));
    const junk = await c.get(`/api/auth/verify?token=${randomBytes(20).toString("hex")}`);
    check("random verify token rejected", (junk.headers.get("location") ?? "").includes("/login?error="));
    const wrongType = await issueAuthToken(u.id, "reset_password");
    const wt = await c.get(`/api/auth/verify?token=${encodeURIComponent(wrongType)}`);
    check("reset token cannot be used as verify token", (wt.headers.get("location") ?? "").includes("/login?error="));
  }

  console.log("\nForgot / reset password");
  {
    const c = new Client();
    await c.post("/api/auth/signup", signupBody("rst"));
    const u = await prisma.users.findUniqueOrThrow({ where: { email: email("rst") } });
    const oldSession = new Client();
    await oldSession.post("/api/auth/login", { email: email("rst"), password: GOOD });
    check("second session active before reset", (await oldSession.get("/api/auth/me")).status === 200);

    const a = await new Client().post("/api/auth/forgot", { email: email("rst") });
    const b = await new Client().post("/api/auth/forgot", { email: email("nobody-here") });
    check("forgot: identical status for known/unknown email", a.status === 200 && b.status === 200, `${a.status}/${b.status}`);
    check("forgot: identical body for known/unknown email", JSON.stringify(a.json) === JSON.stringify(b.json), `${a.text} vs ${b.text}`);

    const tok = await issueAuthToken(u.id, "reset_password");
    const weak = await new Client().post("/api/auth/reset", { token: tok, password: "weak" });
    check("reset rejects weak password (token not burned)", weak.status === 422, String(weak.status));
    const NEW = "BrandNewPass7";
    const rc = new Client();
    const r = await rc.post("/api/auth/reset", { token: tok, password: NEW });
    check("reset succeeds and signs in", r.status === 200 && (await rc.get("/api/auth/me")).status === 200, r.text.slice(0, 120));
    check("old sessions revoked after reset", (await oldSession.get("/api/auth/me")).status === 401);
    check("old password no longer works", (await new Client().post("/api/auth/login", { email: email("rst"), password: GOOD })).status === 401);
    check("new password works", (await new Client().post("/api/auth/login", { email: email("rst"), password: NEW })).status === 200);
    const reuse = await new Client().post("/api/auth/reset", { token: tok, password: "AnotherPass8" });
    check("reset token is single-use", reuse.status === 400, String(reuse.status));
    const t2 = await issueAuthToken(u.id, "reset_password");
    await prisma.auth_tokens.updateMany({ where: { user_id: u.id, used_at: null }, data: { expires_at: new Date(Date.now() - 1000) } });
    check("expired reset token rejected", (await new Client().post("/api/auth/reset", { token: t2, password: "AnotherPass8" })).status === 400);
    const t3 = await issueAuthToken(u.id, "verify_email");
    check("verify token cannot reset a password", (await new Client().post("/api/auth/reset", { token: t3, password: "AnotherPass8" })).status === 400);
  }

  console.log("\nLogin, logout, rate limiting");
  {
    const c = new Client();
    await c.post("/api/auth/signup", signupBody("lg"));
    const out = new Client();
    check("login with right password", (await out.post("/api/auth/login", { email: email("lg"), password: GOOD })).status === 200);
    const rot = new Client();
    await rot.post("/api/auth/login", { email: email("lg"), password: GOOD });
    const firstToken = rot.jar.get("omni_session")!;
    await rot.post("/api/auth/login", { email: email("lg"), password: GOOD });
    const stale = new Client();
    stale.jar.set("omni_session", firstToken);
    check("re-login rotates the session (previous token dies)", rot.jar.get("omni_session") !== firstToken && (await stale.get("/api/auth/me")).status === 401);
    const unk = await new Client().post("/api/auth/login", { email: email("ghost"), password: GOOD });
    const wrong = await new Client().post("/api/auth/login", { email: email("lg"), password: "WrongPass1" });
    check("unknown email and wrong password give the same response", unk.status === 401 && wrong.status === 401 && unk.json?.error === wrong.json?.error, `${unk.status}/${wrong.status}`);
    const sessionCookie = out.jar.get("omni_session")!;
    const lo = await out.post("/api/auth/logout", {});
    check("logout 200 and clears cookie", lo.status === 200 && !out.jar.has("omni_session"));
    const replay = new Client();
    replay.jar.set("omni_session", sessionCookie);
    check("logged-out session token is dead server-side", (await replay.get("/api/auth/me")).status === 401);

    // Per-account limit: 10 attempts / 15 min. Vary the IP so only the per-email limiter can trip.
    let tripped = -1;
    for (let i = 1; i <= 14; i++) {
      const r = await new Client().post("/api/auth/login", { email: email("lg"), password: `Wrong${i}pass` });
      if (r.status === 429) {
        tripped = i;
        check("429 carries Retry-After", !!r.headers.get("retry-after"));
        break;
      }
    }
    check("per-account login rate limit trips (<=14 attempts)", tripped > 0, `tripped=${tripped}`);
    // even the right password is refused while limited (no oracle for the attacker)
    check("right password also 429 while locked", (await new Client().post("/api/auth/login", { email: email("lg"), password: GOOD })).status === 429);

    // Per-IP limit: 20 / 10 min from one IP across different emails.
    const ipc = new Client();
    let ipTrip = -1;
    for (let i = 1; i <= 30; i++) {
      const r = await ipc.post("/api/auth/login", { email: email(`ipx${i}`), password: "Whatever1" });
      if (r.status === 429) {
        ipTrip = i;
        break;
      }
    }
    check("per-IP login rate limit trips (<=30 attempts)", ipTrip > 0, `tripped=${ipTrip}`);
  }

  console.log("\nInvites");
  {
    const owner = new Client();
    await owner.post("/api/auth/signup", signupBody("own"));
    const o = await prisma.users.findUniqueOrThrow({ where: { email: email("own") } });
    // Free plan has 1 team seat (seed), so an invite must be refused with 402 and must NOT be consumed...
    const seatToken = randomBytes(32).toString("base64url");
    await prisma.invites.create({ data: { org_id: o.org_id, email: email("seat"), role: "member", token: sha256(seatToken), expires_at: new Date(Date.now() + 86_400_000) } });
    const seat = await new Client().post("/api/auth/signup", { full_name: "Seat", email: email("seat"), password: GOOD, invite: seatToken });
    check("invite: refused with 402 when the plan has no free seat", seat.status === 402, String(seat.status));
    check("invite: seat-limit refusal leaves invite unused and creates no user", !!(await prisma.invites.findFirst({ where: { token: sha256(seatToken), accepted_at: null } })) && !(await prisma.users.findUnique({ where: { email: email("seat") } })));
    // ...then lift the limit for the remaining scenarios.
    await prisma.organisations.update({ where: { id: o.org_id }, data: { plan: "pro" } });
    const mk = async (to: string, role: "member" | "viewer" | "admin", expiresInMs = 86_400_000) => {
      const token = randomBytes(32).toString("base64url"); // same shape/hash as app/api/team/_invite.ts newInviteToken
      await prisma.invites.create({ data: { org_id: o.org_id, email: to, role, token: sha256(token), expires_at: new Date(Date.now() + expiresInMs) } });
      return token;
    };
    const t = await mk(email("inv"), "viewer");
    const wrong = await new Client().post("/api/auth/signup", { full_name: "Invitee", email: email("someoneelse"), password: GOOD, invite: t });
    check("invite: wrong email rejected (403)", wrong.status === 403, String(wrong.status));
    const ic = new Client();
    const r = await ic.post("/api/auth/signup", { full_name: "Invitee", email: email("inv"), password: GOOD, invite: t });
    check("invite: signup with token + matching email -> 201", r.status === 201, r.text.slice(0, 160));
    const iu = await prisma.users.findUnique({ where: { email: email("inv") } });
    check("invite: joined the inviting org with the invite role", iu?.org_id === o.org_id && iu?.role === "viewer", `${iu?.role}`);
    check("invite: email is marked verified", !!iu?.email_verified_at);
    check("invite: no extra org created for the invitee", (await prisma.organisations.count({ where: { id: iu?.org_id } })) === 1 && iu?.org_id === o.org_id);
    check("invite: invitee session works", (await ic.get("/api/auth/me")).json?.data?.role === "viewer");
    const reuse = await new Client().post("/api/auth/signup", { full_name: "Invitee2", email: email("inv2"), password: GOOD, invite: t });
    check("invite: reused token rejected", reuse.status === 400 || reuse.status === 403, String(reuse.status));
    const exp = await mk(email("late"), "member", -1000);
    const er = await new Client().post("/api/auth/signup", { full_name: "Late", email: email("late"), password: GOOD, invite: exp });
    check("invite: expired token -> 410", er.status === 410, String(er.status));
    const bogus = await new Client().post("/api/auth/signup", { full_name: "Bogus", email: email("bogus"), password: GOOD, invite: randomBytes(32).toString("base64url") });
    check("invite: unknown token -> 400", bogus.status === 400, String(bogus.status));
    const t2 = await mk(email("ci"), "member");
    const ci = await new Client().post("/api/auth/signup", { full_name: "Case", email: email("ci").toUpperCase(), password: GOOD, invite: t2 });
    check("invite: email comparison is case-insensitive", ci.status === 201, `${ci.status} ${ci.text.slice(0, 100)}`);
    const taken = await mk(email("own"), "member");
    const tk = await new Client().post("/api/auth/signup", { full_name: "Dup", email: email("own"), password: GOOD, invite: taken });
    check("invite: existing account email -> 409 (invite not burned silently)", tk.status === 409, String(tk.status));
  }

  console.log("\nCSRF and access control");
  {
    const c = new Client();
    const x = await c.post("/api/auth/signup", signupBody("csrf"), { origin: "https://evil.example" });
    check("cross-origin signup POST blocked (403)", x.status === 403, String(x.status));
    const l = await c.post("/api/auth/login", { email: email("a"), password: GOOD }, { origin: "https://evil.example" });
    check("cross-origin login POST blocked (403)", l.status === 403, String(l.status));
    const same = await c.post("/api/auth/login", { email: email("a"), password: "WrongPass1" }, { origin: BASE });
    check("same-origin POST is not blocked by the Origin check", same.status !== 403, String(same.status));

    const anon = new Client();
    check("/api/auth/me unauthenticated -> 401", (await anon.get("/api/auth/me")).status === 401);
    check("/api/contacts unauthenticated -> 401", (await anon.get("/api/contacts")).status === 401);
    check("/api/billing unauthenticated -> 401", (await anon.get("/api/billing")).status === 401);
    const page = await anon.get("/dashboard");
    check("/dashboard without cookie redirects to /login", page.status === 307 && (page.headers.get("location") ?? "").includes("/login"), `${page.status} ${page.headers.get("location")}`);
    const forged = new Client();
    forged.jar.set("omni_session", randomBytes(32).toString("base64url"));
    check("forged session cookie gets no API access (401)", (await forged.get("/api/contacts")).status === 401);
    const fp = await forged.get("/dashboard");
    check("forged session cookie on a page never renders the dashboard", fp.status === 307 || fp.status === 308, String(fp.status));
    check("public pages render", (await anon.get("/")).status === 200 && (await anon.get("/login")).status === 200 && (await anon.get("/signup")).status === 200);
  }
}

async function cleanup() {
  const users = await prisma.users.findMany({ where: { email: { startsWith: RUN } }, select: { org_id: true } });
  const orgIds = [...new Set(users.map((u) => u.org_id))];
  if (orgIds.length) await prisma.organisations.deleteMany({ where: { id: { in: orgIds } } });
  // limiter rows for the throw-away scope
  await prisma.rate_limits.deleteMany({ where: { key: { contains: RUN } } }).catch(() => undefined);
  console.log(`\ncleanup: removed ${orgIds.length} test org(s)`);
}

main()
  .catch((e) => {
    fail++;
    failures.push(`unhandled: ${(e as Error).message}`);
    console.error(e);
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup failed", e));
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) console.log("Failed:\n - " + failures.join("\n - "));
    process.exit(fail ? 1 : 0);
  });
