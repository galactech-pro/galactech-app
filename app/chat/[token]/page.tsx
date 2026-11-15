import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Script from "next/script";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chat with us", robots: { index: false, follow: false } };

/** Public hosted chat page: no website install needed. Share the link, put it behind a button, or print the QR code. */
export default async function HostedChat({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/.test(token)) notFound();
  const inbox = await prisma.inboxes.findFirst({ where: { webhook_token: token, channel: "webchat", is_active: true }, select: { id: true } }); // tenant-ok: public page, token is the capability
  if (!inbox) notFound();
  return (
    <main style={{ minHeight: "100vh", background: "#000" }}>
      <noscript><p style={{ color: "#ededed", padding: 24 }}>Please turn on JavaScript to chat with us.</p></noscript>
      <Script src="/webchat.js" strategy="afterInteractive" data-token={token} data-mode="page" />
    </main>
  );
}
