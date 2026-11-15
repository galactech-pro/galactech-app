import Link from "next/link";
import {
  ArrowRight, BarChart3, Bot, Check, ChevronDown, Facebook, Globe, Inbox, Instagram, Lock, Mail, MessageCircle, Phone, Send, ShieldCheck,
  Smartphone, Sparkles, UserCog, Users, Workflow,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Brand } from "@/components/app/brand";

const CHANNELS: { icon: LucideIcon; name: string; color: string }[] = [
  { icon: MessageCircle, name: "WhatsApp", color: "text-emerald-400" },
  { icon: Mail, name: "Email", color: "text-sky-400" },
  { icon: Send, name: "Telegram", color: "text-cyan-400" },
  { icon: Instagram, name: "Instagram", color: "text-pink-400" },
  { icon: Facebook, name: "Messenger", color: "text-blue-400" },
  { icon: Smartphone, name: "SMS", color: "text-amber-300" },
  { icon: Globe, name: "Web chat", color: "text-violet-300" },
  { icon: Phone, name: "AI voice", color: "text-fuchsia-300" },
];

const FEATURES: { icon: LucideIcon; title: string; body: string; wide?: boolean }[] = [
  { icon: Inbox, title: "One inbox for every channel", body: "WhatsApp, email, Telegram, Instagram, Messenger, SMS and web chat land in a single timeline per customer, so nobody has to switch tabs or repeat themselves.", wide: true },
  { icon: Bot, title: "AI that asks before it sends", body: "AI drafts replies from your own knowledge and shows its sources. Nothing goes out until a teammate approves it." },
  { icon: Users, title: "A CRM that fills itself", body: "Contacts, tags, notes, deals and tasks, with an AI score so you call the hottest leads first." },
  { icon: Workflow, title: "Visual automations", body: "Drag-and-drop follow-ups with delays, conditions and ready-made templates for reminders and win-backs." },
  { icon: Phone, title: "AI voice calls", body: "An AI agent phones leads in English and Hindi inside your calling hours and logs the outcome." },
  { icon: BarChart3, title: "Revenue analytics", body: "See delivery, replies and the revenue each campaign brings in, plus a weekly summary." },
  { icon: UserCog, title: "Teams and roles", body: "Owner, admin, member and viewer roles, with an audit trail of who did what." },
  { icon: ShieldCheck, title: "Consent built in", body: "Opt-outs, Do-Not-Contact and calling windows are checked before every single send." },
];

const STEPS = [
  { n: "01", title: "Connect your channels", body: "Paste a Telegram bot token, link your WhatsApp number, add your email domain. Each takes a few minutes." },
  { n: "02", title: "Bring your contacts", body: "Import a CSV or let leads arrive from forms and chat. Duplicates are merged automatically." },
  { n: "03", title: "Reply and automate", body: "Answer from the shared inbox, switch on follow-up automations and watch the numbers climb." },
];

const PLANS = [
  { name: "Starter", price: "999", blurb: "For solo founders getting started", items: ["1,000 contacts", "1,000 WhatsApp messages / month", "5,000 emails / month", "5 automations", "3 team seats"] },
  { name: "Growth", price: "2,999", blurb: "For growing sales teams", highlight: true, items: ["5,000 contacts", "5,000 WhatsApp messages / month", "25,000 emails / month", "100 AI calls / month", "25 automations", "10 team seats"] },
  { name: "Pro", price: "7,999", blurb: "For agencies and high-volume teams", items: ["25,000 contacts", "25,000 WhatsApp messages / month", "100,000 emails / month", "500 AI calls / month", "100 automations", "50 team seats, API access"] },
];

const FAQ = [
  { q: "Do I need a WhatsApp Business account?", a: "Yes. GalacTech uses Meta's official WhatsApp Cloud API, so you connect a WhatsApp Business number through your own Meta business account. Meta charges you directly for template messages; we add no per-message markup." },
  { q: "Will the AI send messages on its own?", a: "Not by default. AI-written replies are saved as drafts that a person approves. Automatic outreach is off until you switch it on and the contact has recorded consent." },
  { q: "How do you handle opt-outs and consent?", a: "Every send goes through one gate that checks opt-out, Do-Not-Contact, recorded consent for marketing, and your calling hours. A STOP reply is honoured immediately." },
  { q: "Where is my data stored?", a: "In a managed PostgreSQL database, isolated per organisation in code. Channel credentials are encrypted at rest. You can export your contacts at any time." },
  { q: "Can I try it before paying?", a: "Every plan starts with a 7-day free trial and no credit card." },
];

function InboxMock() {
  const rows = [
    { n: "Asha Verma", t: "Can I get the price list?", c: "bg-emerald-500", ic: MessageCircle, active: true },
    { n: "Rohit Mehta", t: "Thanks, invoice received", c: "bg-sky-500", ic: Mail },
    { n: "@priya.designs", t: "Do you ship to Pune?", c: "bg-pink-500", ic: Instagram },
    { n: "Vikram S.", t: "/start", c: "bg-cyan-500", ic: Send },
  ];
  return (
    <div className="relative mx-auto mt-14 max-w-4xl">
      <div className="absolute -inset-x-6 -inset-y-4 rounded-[2rem] bg-brand opacity-25 blur-3xl" aria-hidden />
      <div className="relative overflow-hidden rounded-2xl border border-white/15 bg-[hsl(232_40%_12%)] text-left shadow-2xl">
        <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" /><span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
          <span className="ml-3 text-xs text-white/40">GalacTech Â· Inbox</span>
        </div>
        <div className="grid sm:grid-cols-[250px_1fr]">
          <ul className="hidden border-r border-white/10 sm:block">
            {rows.map(({ n, t, c, ic: Ic, active }) => (
              <li key={n} className={"flex items-center gap-3 px-4 py-3.5 " + (active ? "bg-white/[0.07]" : "")}>
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${c} text-white`}><Ic className="h-4 w-4" /></span>
                <span className="min-w-0"><span className="block truncate text-sm font-medium text-white">{n}</span><span className="block truncate text-xs text-white/50">{t}</span></span>
              </li>
            ))}
          </ul>
          <div className="space-y-3 p-5 text-sm">
            <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white/10 px-4 py-2.5 text-white/90">Hi! Can I get the price list for the Growth plan?</div>
            <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-brand px-4 py-2.5 text-white">Sure Asha. It is â‚¹2,999 a month with a 7-day free trial. Want me to set one up?</div>
            <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-cyan/50 bg-cyan/10 p-3 text-xs text-white/80">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-cyan" />
              <span><b className="text-white">AI draft, waiting for approval.</b> Sources: Pricing FAQ. A teammate reviews it before it is sent.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-background">
      <section className="relative overflow-hidden bg-space text-white">
        <div className="stars animate-twinkle absolute inset-0" aria-hidden />
        <header className="relative z-10">
          <div className="mx-auto flex h-20 max-w-6xl items-center justify-between px-4">
            <Brand light />
            <nav aria-label="Primary" className="hidden items-center gap-8 text-sm text-white/70 md:flex">
              <a href="#features" className="hover:text-white">Features</a>
              <a href="#how" className="hover:text-white">How it works</a>
              <a href="#pricing" className="hover:text-white">Pricing</a>
              <a href="#faq" className="hover:text-white">FAQ</a>
            </nav>
            <div className="flex items-center gap-2">
              <Button asChild variant="ghost" size="sm" className="text-white hover:bg-white/10 hover:text-white"><Link href="/login">Sign in</Link></Button>
              <Button asChild size="sm" variant="brand"><Link href="/signup">Start free</Link></Button>
            </div>
          </div>
        </header>

        <div className="relative z-10 mx-auto max-w-4xl px-4 pb-24 pt-14 text-center sm:pt-20">
          <span className="glass inline-flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-medium text-white/90">
            <Sparkles className="h-3.5 w-3.5 text-cyan" /> WhatsApp Â· Email Â· Telegram Â· Instagram Â· AI voice
          </span>
          <h1 className="mt-6 font-display text-4xl font-bold leading-[1.08] tracking-tight min-[420px]:text-5xl sm:text-7xl">
            Every channel.<br /><span className="text-gradient">One inbox.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-white/70">
            GalacTech brings every customer conversation into one place, with a CRM, automations and AI that helps but never sends without your say-so.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" variant="brand"><Link href="/signup">Start your 7-day free trial <ArrowRight /></Link></Button>
            <Button asChild size="lg" variant="outline" className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white"><a href="#features">See what&apos;s inside</a></Button>
          </div>
          <p className="mt-3 text-xs text-white/50">No credit card required. Cancel anytime.</p>
          <InboxMock />
        </div>

        <div className="relative z-10 border-t border-white/10 bg-black/20">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-3 px-4 py-6">
            {CHANNELS.map(({ icon: Icon, name, color }) => (
              <span key={name} className="flex items-center gap-2 text-sm text-white/70"><Icon className={"h-4 w-4 " + color} />{name}</span>
            ))}
          </div>
        </div>
      </section>

      <main>
        <section id="features" className="mx-auto max-w-6xl px-4 py-24">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold uppercase tracking-wider text-primary">Features</p>
            <h2 className="mt-2 font-display text-4xl font-bold tracking-tight">Everything between &ldquo;new lead&rdquo; and &ldquo;closed deal&rdquo;</h2>
            <p className="mt-3 text-muted-foreground">One platform instead of five tools stitched together.</p>
          </div>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body, wide }) => (
              <div key={title} className={"group rounded-2xl border bg-card p-6 shadow-soft transition hover:-translate-y-0.5 hover:border-primary/40 " + (wide ? "sm:col-span-2" : "")}>
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-primary transition group-hover:bg-brand group-hover:text-white"><Icon className="h-5 w-5" /></span>
                <h3 className="mt-5 font-display text-lg font-semibold">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="how" className="bg-muted/60 py-24">
          <div className="mx-auto max-w-6xl px-4">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-sm font-semibold uppercase tracking-wider text-primary">How it works</p>
              <h2 className="mt-2 font-display text-4xl font-bold tracking-tight">Live in an afternoon</h2>
            </div>
            <div className="mt-14 grid gap-6 md:grid-cols-3">
              {STEPS.map((s) => (
                <div key={s.n} className="rounded-2xl border bg-card p-7 shadow-soft">
                  <span className="font-display text-5xl font-bold text-gradient">{s.n}</span>
                  <h3 className="mt-4 font-display text-xl font-semibold">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 py-24">
          <div className="relative overflow-hidden rounded-3xl bg-space p-10 text-white sm:p-14">
            <div className="stars absolute inset-0" aria-hidden />
            <div className="relative grid items-center gap-8 md:grid-cols-[auto_1fr]">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand shadow-glow"><Lock className="h-8 w-8" /></span>
              <div>
                <h2 className="font-display text-3xl font-bold tracking-tight">Built for outreach you can defend</h2>
                <p className="mt-3 max-w-2xl text-white/70">
                  Opt-out, Do-Not-Contact and calling windows are enforced before every send. Webhooks are signature-verified and de-duplicated,
                  credentials are encrypted at rest, and every query is scoped to your organisation.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section id="pricing" className="bg-muted/60 py-24">
          <div className="mx-auto max-w-6xl px-4">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-sm font-semibold uppercase tracking-wider text-primary">Pricing</p>
              <h2 className="mt-2 font-display text-4xl font-bold tracking-tight">Simple pricing in rupees</h2>
              <p className="mt-3 text-muted-foreground">Every plan starts with a 7-day free trial. WhatsApp message fees are billed by Meta directly.</p>
            </div>
            <div className="mt-14 grid gap-6 md:grid-cols-3">
              {PLANS.map((p) => (
                <div key={p.name} className={"relative flex flex-col rounded-2xl border bg-card p-7 shadow-soft " + (p.highlight ? "border-primary ring-2 ring-primary/30" : "")}>
                  {p.highlight ? <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand px-3 py-0.5 text-xs font-semibold text-white">Most popular</span> : null}
                  <h3 className="font-display text-xl font-semibold">{p.name}</h3>
                  <p className="text-sm text-muted-foreground">{p.blurb}</p>
                  <p className="mt-5"><span className="font-display text-5xl font-bold">â‚¹{p.price}</span><span className="text-sm text-muted-foreground"> / month</span></p>
                  <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                    {p.items.map((i) => (
                      <li key={i} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />{i}</li>
                    ))}
                  </ul>
                  <Button asChild className="mt-7" variant={p.highlight ? "brand" : "outline"}><Link href="/signup">Start free trial</Link></Button>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="faq" className="mx-auto max-w-3xl px-4 py-24">
          <h2 className="text-center font-display text-4xl font-bold tracking-tight">Questions, answered</h2>
          <div className="mt-10 divide-y rounded-2xl border bg-card shadow-soft">
            {FAQ.map((f) => (
              <details key={f.q} className="group p-6">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                  {f.q}
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition group-open:rotate-180" />
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="px-4 pb-24">
          <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl bg-brand p-12 text-center text-white sm:p-16">
            <h2 className="font-display text-4xl font-bold tracking-tight">Ready to hear from every customer, everywhere?</h2>
            <p className="mx-auto mt-3 max-w-xl text-white/85">Start free for 7 days. Connect a channel in minutes.</p>
            <Button asChild size="lg" className="mt-8 bg-white text-primary hover:bg-white/90"><Link href="/signup">Create your workspace <ArrowRight /></Link></Button>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row">
          <Brand />
          <span>Â© {new Date().getFullYear()} GalacTech. All rights reserved.</span>
          <div className="flex gap-5">
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
            <Link href="/login" className="hover:text-foreground">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
