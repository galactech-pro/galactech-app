import { fail, ok, safe, isCrossOriginMutation } from "@/lib/api";
import { destroySession } from "@/lib/auth";

export const POST = safe(async (req) => {
  if (isCrossOriginMutation(req)) return fail("Cross-origin request blocked", 403);
  await destroySession();
  return ok({ signed_out: true });
});
