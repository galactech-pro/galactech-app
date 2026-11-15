import Link from "next/link";
import { Check } from "lucide-react";
import { Brand } from "@/components/app/brand";

const POINTS = [
  "WhatsApp, email, Telegram and Instagram in one inbox",
  "AI-drafted replies that always wait for your approval",
  "Consent, opt-out and calling-hour checks before every send",
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel */}
      <aside className="relative hidden overflow-hidden bg-space p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="stars animate-twinkle absolute inset-0" aria-hidden />
        <Brand light className="relative" />
        <div className="relative max-w-md">
          <h2 className="font-display text-4xl font-bold leading-tight tracking-tight">
            Every channel.<br />
            <span className="text-gradient">One inbox.</span> Zero missed leads.
          </h2>
          <ul className="mt-8 space-y-3.5">
            {POINTS.map((p) => (
              <li key={p} className="flex items-start gap-3 text-[15px] text-white/80">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-cyan"><Check className="h-3 w-3" /></span>
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/50">© {new Date().getFullYear()} GalacTech</p>
      </aside>

      {/* Form panel */}
      <div className="flex flex-col items-center justify-center bg-background px-4 py-10 sm:px-8">
        <Brand className="mb-8 lg:hidden" />
        <div className="w-full max-w-md">{children}</div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          By continuing you agree to our <Link href="/terms" className="underline">Terms</Link> and{" "}
          <Link href="/privacy" className="underline">Privacy Policy</Link>.
        </p>
      </div>
    </div>
  );
}
