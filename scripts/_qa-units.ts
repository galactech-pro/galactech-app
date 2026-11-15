import { createHash, createHmac } from "node:crypto";
import { prisma } from "../lib/db";
import { cleanReplyText, isAutomatedMail, parseAddress, routingKeyFromAddress, verifySvix, inboundAddress } from "../lib/email/inbound";
import { issueOtp, consumeOtp } from "../lib/knowledge/otp";
import { syncStaticSource, retrieve } from "../lib/knowledge";

let fails = 0;
const check = (name: string, cond: boolean) => {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) fails++;
};

async function main() {
  // ---- svix signature
  process.env.INBOUND_EMAIL_DOMAIN = "in.example.com";
  const secret = "whsec_" + Buffer.from("test-secret-key-123456").toString("base64");
  const id = "msg_1", ts = String(Math.floor(Date.now() / 1000)), body = '{"type":"email.received"}';
  const sig = createHmac("sha256", Buffer.from("test-secret-key-123456")).update(`${id}.${ts}.${body}`).digest("base64");
  const h = (s: string, t = ts) => new Headers({ "svix-id": id, "svix-timestamp": t, "svix-signature": s });
  check("svix: valid signature accepted", verifySvix(h("v1," + sig), body, secret));
  check("svix: second signature in list accepted", verifySvix(h("v1,AAAA v1," + sig), body, secret));
  check("svix: tampered body rejected", !verifySvix(h("v1," + sig), body + " ", secret));
  check("svix: wrong secret rejected", !verifySvix(h("v1," + sig), body, "whsec_" + Buffer.from("other").toString("base64")));
  check("svix: stale timestamp rejected", !verifySvix(h("v1," + sig, String(Math.floor(Date.now() / 1000) - 3600)), body, secret));
  check("svix: missing headers rejected", !verifySvix(new Headers(), body, secret));

  // ---- routing
  const addr = inboundAddress("abcdef0123456789ffffffffffffffffffffffffffffffff")!;
  check("address format", addr === "in-abcdef0123456789@in.example.com");
  check("routing key parsed", routingKeyFromAddress(`Support <${addr}>`) === "abcdef0123456789");
  check("foreign domain ignored", routingKeyFromAddress("in-abcdef0123456789@evil.com") === null);
  check("plain address ignored", routingKeyFromAddress("hello@in.example.com") === null);
  check("parseAddress", JSON.stringify(parseAddress('"Asha V" <ASHA@X.com>')) === JSON.stringify({ name: "Asha V", email: "asha@x.com" }));

  // ---- loop protection + reply cleaning
  check("auto-submitted skipped", isAutomatedMail("a@b.com", { "auto-submitted": "auto-replied" }));
  check("noreply skipped", isAutomatedMail("No Reply <noreply@shop.com>", {}));
  check("newsletter skipped", isAutomatedMail("a@b.com", { "list-unsubscribe": "<x>" }));
  check("human mail kept", !isAutomatedMail("Asha <asha@x.com>", { "auto-submitted": "no" }));
  const cleaned = cleanReplyText("Thanks, that works!\n\nOn Mon, 3 Nov 2026 at 10:00, Support <s@x.com> wrote:\n> Hello there\n> more", "");
  check("quoted history removed", cleaned === "Thanks, that works!");
  check("html-only mail handled", cleanReplyText("", "<p>Hi <b>team</b></p><p>Need a quote</p>").includes("Need a quote"));

  // ---- OTP lifecycle + private knowledge against the real DB
  const org = await prisma.organisations.create({ data: { name: "QA Org", slug: "qa-" + Date.now() } });
  try {
    const user = await prisma.users.create({ data: { org_id: org.id, email: "delivered+qa" + Date.now() + "@resend.dev", full_name: "QA", role: "owner", password_hash: "x" } as never });
    const issued = await issueOtp({ id: user.id, email: user.email }, org.id, "kb_add_private", { title: "Price list", content: "Wholesale price of Widget X is 4500 rupees." });
    check("otp issued and email sent", !!issued.otp_id && issued.sent_to.includes("@"));
    const row = await prisma.action_otps.findFirst({ where: { id: issued.otp_id, org_id: org.id } });
    check("payload stored encrypted", !!row && !row.payload.includes("Wholesale"));
    let wrong = "";
    try { await consumeOtp(user.id, org.id, issued.otp_id, "000000", "kb_add_private"); wrong = "accepted"; } catch (e) { wrong = (e as Error).message; }
    check("wrong code rejected: " + wrong, wrong !== "accepted");
    // brute-force our own 6-digit code from the stored hash (test only)
    let code = "";
    for (let i = 0; i < 1_000_000; i++) {
      const c = String(i).padStart(6, "0");
      if (createHash("sha256").update(`${issued.otp_id}:${c}`).digest("hex") === row!.code_hash) { code = c; break; }
    }
    check("code recovered for test", code.length === 6);
    const wrongPurpose = await consumeOtp(user.id, org.id, issued.otp_id, code, "kb_delete").then(() => "accepted", () => "rejected");
    check("code cannot be used for another action", wrongPurpose === "rejected");
    const otherUser = await consumeOtp("00000000-0000-0000-0000-000000000000", org.id, issued.otp_id, code, "kb_add_private").then(() => "accepted", () => "rejected");
    check("code cannot be used by another user", otherUser === "rejected");
    const payload = await consumeOtp<{ title: string }>(user.id, org.id, issued.otp_id, code, "kb_add_private");
    check("correct code returns the pending action", payload.title === "Price list");
    const again = await consumeOtp(user.id, org.id, issued.otp_id, code, "kb_add_private").then(() => "accepted", () => "rejected");
    check("code is single use", again === "rejected");

    // lockout after 5 wrong attempts
    const i2 = await issueOtp({ id: user.id, email: user.email }, org.id, "kb_add_private", { title: "x", content: "yyyyyyyyyyyy" });
    for (let k = 0; k < 5; k++) await consumeOtp(user.id, org.id, i2.otp_id, "111111", "kb_add_private").catch(() => null);
    const r2 = await prisma.action_otps.findFirst({ where: { id: i2.otp_id, org_id: org.id } });
    let correct = "";
    for (let i = 0; i < 1_000_000; i++) { const c = String(i).padStart(6, "0"); if (createHash("sha256").update(`${i2.otp_id}:${c}`).digest("hex") === r2!.code_hash) { correct = c; break; } }
    const locked = await consumeOtp(user.id, org.id, i2.otp_id, correct, "kb_add_private").then(() => "accepted", () => "rejected");
    check("locked after 5 wrong attempts (even with the right code)", locked === "rejected");

    // private chunks carry visibility + are retrievable
    const src = await prisma.knowledge_sources.create({ data: { org_id: org.id, type: "text", title: "Price list", content: "Wholesale price of Widget X is 4500 rupees per unit for orders above 100 units.", visibility: "private" } });
    await syncStaticSource(org.id, src.id);
    const hits = await retrieve(org.id, "What is the wholesale price of Widget X?", 3);
    check("private knowledge retrievable and flagged private", hits.length > 0 && hits.every((x) => x.visibility === "private"));
    const other = await prisma.organisations.create({ data: { name: "Other", slug: "qa2-" + Date.now() } });
    const leak = await retrieve(other.id, "wholesale price Widget X", 3);
    check("no cross-tenant leakage", leak.length === 0);
    await prisma.organisations.delete({ where: { id: other.id } });
  } finally {
    await prisma.organisations.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
}
main().catch((e) => {
  console.error("CRASH", e);
  process.exit(1);
});
