import { withAuth, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** POST multipart/form-data with field "file" (png/jpg/webp, <=2MB) → stored in the database (org_logos) and served from /api/public/logo/[orgId]. */
export const POST = withAuth(
  async (req, session) => {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return fail("file is required", 422);
    const ext = TYPES[file.type];
    if (!ext) return fail("Logo must be PNG, JPEG or WebP", 422);
    if (file.size > 2 * 1024 * 1024) return fail("Logo must be 2MB or smaller", 422);

    const bytes = Buffer.from(await file.arrayBuffer());
    // L-06: the client-declared type is not trusted; the file signature must match.
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isWebp = bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
    const sniffed = (ext === "png" && isPng) || (ext === "jpg" && isJpg) || (ext === "webp" && isWebp);
    if (!sniffed) return fail("File content does not match the declared image type", 422);

    await prisma.org_logos.upsert({
      where: { org_id: session.org_id },
      create: { org_id: session.org_id, content_type: file.type, data: bytes },
      update: { content_type: file.type, data: bytes },
    });
    const logoUrl = `/api/public/logo/${session.org_id}?v=${Date.now()}`;
    await prisma.organisations.update({ where: { id: session.org_id }, data: { logo_url: logoUrl } });
    await audit(session, "settings.logo", "organisation", session.org_id);
    return ok({ logo_url: logoUrl });
  },
  { role: "admin" }
);
