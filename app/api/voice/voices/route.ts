import { withAuth, ok } from "@/lib/api";
import { listVoices } from "@/lib/voice";

export const GET = withAuth(async () => ok(await listVoices()));
