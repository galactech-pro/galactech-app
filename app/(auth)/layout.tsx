import Link from "next/link";
import { Brand } from "@/components/app/brand";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="relative hidden border-r bg-black p-12 lg:flex lg:flex-col lg:justify-between">
        <div className="grid-lines absolute inset-0" aria-hidden />
        <Brand className="relative" />
        <div className="relative max-w-md">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight">Every channel.<br />One inbox.</h2>
          <p className="mt-4 text-muted-foreground">WhatsApp, email, Telegram and Instagram in one place. AI drafts replies and always waits for your approval.</p>
          <div className="mt-8 rounded-lg border bg-card p-4 font-mono text-xs leading-relaxed text-[#ccc]">
            <p><span className="text-muted-foreground">POST</span> /api/public/v1/messages</p>
            <p className="mt-1 flex items-center gap-2 text-primary"><span className="h-1.5 w-1.5 rounded-full bg-primary" /> 201 Created · queued to inbox</p>
          </div>
        </div>
        <p className="relative text-xs text-muted-foreground">© {new Date().getFullYear()} GalacTech</p>
      </aside>

      <div className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
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
