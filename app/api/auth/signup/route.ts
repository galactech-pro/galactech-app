import { z } from "zod";
import { fail, ok, parseBody, safe, isCrossOriginMutation } from "@/lib/api";
import { createSession } from "@/lib/auth";
import { hashPassword, passwordProblem } from "@/lib/password";
import { provisionOrgForUser } from "../_lib/provision";
import { findInviteByToken } from "@/app/api/team/_invite";
import { acceptInviteForNewUser } from "@/app/api/team/_accept";
import { sendVerificationEmail } from "../_lib/verification";
import { clientIp, limitOrResponse } from "@/lib/rate-limit";

const schema = z.object({
  full_name: z.string().trim().min(2).max(120),
  org_name: z.string().trim().max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().max(200),
  invite: z.string().min(10).max(200).optional(),
});

/** Creates the account (+ workspace, or joins the inviting workspace) and signs the user in. */
export const POST = safe(async (req) => {
  if (isCrossOriginMutation(req)) return fail("Cross-origin request blocked", 403);
  const ip = clientIp(req);
  const limited = (await limitOrResponse(`signup:${ip}:min`, { limit: 5, windowSec: 60 })) ?? (await limitOrResponse(`signup:${ip}:day`, { limit: 30, windowSec: 86400 }));
  if (limited) return limited;
  const body = await parseBody(req, schema);
  const problem = passwordProblem(body.password);
  if (problem) return fail(`Password: ${problem}`, 422);
  const passwordHash = await hashPassword(body.password);

  try {
    let userId: string;
    if (body.invite) {
      const invite = await findInviteByToken(body.invite);
      if (!invite || invite.accepted_at) return fail("Invite is invalid or already used", 400);
      if (invite.expires_at < new Date()) return fail("Invite has expired", 410);
      if (invite.email.toLowerCase() !== body.email) return fail("This invite was sent to a different email address", 403);
      userId = (await acceptInviteForNewUser({ email: body.email, fullName: body.full_name, passwordHash }, invite)).id;
    } else {
      if (!body.org_name || body.org_name.length < 2) return fail("Enter your business name", 422);
      const r = await provisionOrgForUser({ email: body.email, passwordHash, fullName: body.full_name, orgName: body.org_name });
      userId = r.userId;
      await sendVerificationEmail(userId, body.email, body.full_name);
    }
    await createSession(userId, { ip, userAgent: req.headers.get("user-agent") });
    return ok({ user_id: userId, invited: !!body.invite }, 201);
  } catch (e) {
    if (e instanceof Error && e.message === "EMAIL_TAKEN") return fail("An account with this email already exists. Try signing in instead.", 409);
    if (e instanceof Error && e.message === "INVITE_ALREADY_USED") return fail("Invite is invalid or already used", 400);
    throw e;
  }
});
