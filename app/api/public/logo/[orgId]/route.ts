import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

/** Public org logo (served from the DB; replaces Supabase Storage). Content-Type is fixed at upload time after signature sniffing. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  if (!z.string().uuid().safeParse(orgId).success) return new NextResponse("Not found", { status: 404 });
  const row = await prisma.org_logos.findUnique({ where: { org_id: orgId } }); // tenant-ok: public asset keyed by org id
  if (!row) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(row.data), {
    headers: {
      "Content-Type": row.content_type,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
