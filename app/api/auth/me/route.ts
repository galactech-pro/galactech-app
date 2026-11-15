import { withAuth, ok } from "@/lib/api";

export const GET = withAuth(async (_req, session) =>
  ok({ id: session.user.id, email: session.user.email, full_name: session.user.full_name, role: session.user.role, email_verified: session.user.email_verified, org_id: session.org_id })
);
