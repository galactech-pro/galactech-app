import type { Metadata, Viewport } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/app/providers";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

const SITE = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: "OmniReach - WhatsApp, Email, Telegram & AI voice in one inbox", template: "%s · OmniReach" },
  description: "OmniReach brings WhatsApp, email, Telegram, Instagram and AI voice follow-ups into one inbox, with a CRM, automations and analytics built for growing businesses.",
  applicationName: "OmniReach",
  openGraph: { title: "OmniReach", description: "Every channel. One inbox. Zero missed leads.", siteName: "OmniReach", type: "website" },
};

export const viewport: Viewport = { themeColor: "#000000", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
