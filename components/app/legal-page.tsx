import Link from "next/link";
import { Zap } from "lucide-react";

export function LegalPage({ title, updated, sections }: { title: string; updated: string; sections: { h: string; p: string[] }[] }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Zap className="h-4 w-4" /></span>
            GalacTech
          </Link>
          <Link href="/login" className="text-sm text-foreground underline underline-offset-2 hover:no-underline">Sign in</Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {updated}</p>
        <div className="mt-8 space-y-8">
          {sections.map((s) => (
            <section key={s.h}>
              <h2 className="text-lg font-semibold">{s.h}</h2>
              {s.p.map((t) => (
                <p key={t} className="mt-2 text-sm leading-relaxed text-muted-foreground">{t}</p>
              ))}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
