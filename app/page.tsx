import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Brand } from "@/components/app/brand";

const CHANNELS = ["WhatsApp", "Email", "Telegram", "Instagram", "Messenger", "SMS", "Web chat", "Voice"];

const FEATURES = [
  { title: "One inbox", body: "WhatsApp, email, Telegram, Instagram, Messenger, SMS and web chat in a single timeline per customer." },
  { title: "AI that asks first", body: "Replies are drafted from your own knowledge, with sources. Nothing is sent until a teammate approves it." },
  { title: "A CRM that fills itself", body: "Contacts, tags, notes, deals and tasks, with a score so you reach the hottest leads first." },
  { title: "Automations", body: "Visual follow-ups with delays and conditions. Ready-made templates for reminders and win-backs." },
  { title: "Voice calls", body: "An AI agent phones leads in English and Hindi, inside your calling hours, and logs the outcome." },
  { title: "Consent by default", body: "Opt-out, Do-Not-Contact and calling windows are checked before every single send." },
];

const STEPS = [
  { n: "01", title: "Connect channels", body: "Paste a Telegram bot token, link WhatsApp, verify your email domain. A few minutes each." },
  { n: "02", title: "Bring contacts", body: "Import a CSV or let leads arrive from forms and chat. Duplicates are merged." },
  { n: "03", title: "Reply and automate", body: "Answer from the shared inbox and switch on follow-ups." },
];

const PLANS = [
  { name: "Starter", price: "999", blurb: "Solo founders getting started", items: ["1,000 contacts", "1,000 WhatsApp messages / month", "5,000 emails / month", "5 automations", "3 team seats"] },
  { name: "Growth", price: "2,999", blurb: "Growing sales teams", highlight: true, items: ["5,000 contacts", "5,000 WhatsApp messages / month", "25,000 emails / month", "100 AI calls / month", "25 automations", "10 team seats"] },
  { name: "Pro", price: "7,999", blurb: "Agencies and high volume", items: ["25,000 contacts", "25,000 WhatsApp messages / month", "100,000 emails / month", "500 AI calls / month", "100 automations", "50 seats, API access"] },
];

const FAQ = [
  { q: "Do I need a WhatsApp Business account?", a: "Yes. OmniReach uses Meta's official WhatsApp Cloud API, so you connect a WhatsApp Business number through your own Meta business account. Meta bills template messages to you directly; we add no per-message markup." },
  { q: "Will the AI send messages on its own?", a: "Not by default. AI-written replies are saved as drafts that a person approves. Automatic outreach stays off until you switch it on and the contact has recorded consent." },
  { q: "How do you handle opt-outs and consent?", a: "Every send goes through one gate that checks opt-out, Do-Not-Contact, recorded consent for marketing and your calling hours. A STOP reply is honoured immediately." },
  { q: "Where is my data stored?", a: "In a managed PostgreSQL database, isolated per organisation. Channel credentials are encrypted at rest and you can export your contacts at any time." },
  { q: "Can I try it before paying?", a: "Every plan starts with a 7-day free trial and no credit card." },
];

function CodeCard() {
  return (
    <div className="mx-auto mt-16 max-w-3xl overflow-hidden rounded-lg border bg-card text-left shadow-menu">
      <div className="flex items-center justify-between border-b px-4 py-2.5 text-xs">
        <div className="flex gap-1">
          <span className="rounded-sm bg-secondary px-2 py-1 text-foreground">cURL</span>
          <span className="rounded-sm px-2 py-1 text-muted-foreground">Node.js</span>
          <span className="rounded-sm px-2 py-1 text-muted-foreground">Python</span>
        </div>
        <span className="flex items-center gap-1.5 text-primary"><span className="h-1.5 w-1.5 rounded-full bg-primary" /> 201 Created</span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-[#ccc]">
{`curl -X POST https://app.galactech.pro/api/public/v1/messages \\
  -H "Authorization: Bearer $GALACTECH_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "source_id": "user_4821",
    "name": "Asha Verma",
    "content": "Can I get the price list?"
  }'`}
      </pre>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-background">
      <header className="sticky top-0 z-40 border-b bg-black/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Brand />
          <nav aria-label="Primary" className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#how" className="hover:text-foreground">How it works</a>
            <a href="#pricing" className="hover:text-foreground">Pricing</a>
            <a href="#faq" className="hover:text-foreground">FAQ</a>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm"><Link href="/login">Sign in</Link></Button>
            <Button asChild size="sm"><Link href="/signup">Start free</Link></Button>
          </div>
        </div>
      </header>

      <main>
        <section className="relative">
          <div className="grid-lines absolute inset-0" aria-hidden />
          <div className="relative mx-auto max-w-4xl px-4 pb-24 pt-24 text-center sm:pt-32">
            <p className="inline-block rounded-sm border px-3 py-1 text-xs text-muted-foreground">WhatsApp · Email · Telegram · Instagram · Voice</p>
            <h1 className="mt-8 text-5xl font-semibold tracking-tight sm:text-[56px] sm:leading-[1.1]">
              Every channel.<br />One inbox.
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-base text-muted-foreground">
              OmniReach brings every customer conversation into one place, with a CRM, automations and AI that helps but never sends without your say-so.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button asChild size="lg"><Link href="/signup">Start your 7-day free trial <ArrowRight /></Link></Button>
              <Button asChild size="lg" variant="outline"><a href="#features">See what&apos;s inside</a></Button>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">No credit card required. Cancel anytime.</p>
            <CodeCard />
          </div>
          <div className="relative border-y">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-4 py-6 text-sm text-muted-foreground">
              {CHANNELS.map((c) => <span key={c}>{c}</span>)}
            </div>
          </div>
        </section>

        <section id="features" className="mx-auto max-w-6xl px-4 py-24">
          <h2 className="max-w-2xl text-4xl font-semibold tracking-tight">Everything between &ldquo;new lead&rdquo; and &ldquo;closed deal&rdquo;</h2>
          <p className="mt-3 max-w-xl text-muted-foreground">One platform instead of five tools stitched together.</p>
          <div className="mt-12 grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="bg-card p-6">
                <h3 className="text-lg font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="how" className="border-y">
          <div className="mx-auto max-w-6xl px-4 py-24">
            <h2 className="text-4xl font-semibold tracking-tight">Live in an afternoon</h2>
            <div className="mt-12 grid gap-8 md:grid-cols-3">
              {STEPS.map((s) => (
                <div key={s.n}>
                  <span className="font-mono text-sm text-muted-foreground">{s.n}</span>
                  <h3 className="mt-3 text-xl font-semibold">{s.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="pricing" className="mx-auto max-w-6xl px-4 py-24">
          <h2 className="text-4xl font-semibold tracking-tight">Simple pricing in rupees</h2>
          <p className="mt-3 max-w-xl text-muted-foreground">Every plan starts with a 7-day free trial. WhatsApp message fees are billed by Meta directly.</p>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {PLANS.map((p) => (
              <div key={p.name} className={"flex flex-col rounded-lg border bg-card p-6 " + (p.highlight ? "border-foreground" : "")}>
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">{p.name}</h3>
                  {p.highlight ? <span className="rounded-sm border border-primary/40 px-2 py-0.5 text-xs text-primary">Popular</span> : null}
                </div>
                <p className="text-sm text-muted-foreground">{p.blurb}</p>
                <p className="mt-5"><span className="text-4xl font-semibold">₹{p.price}</span><span className="text-sm text-muted-foreground"> / month</span></p>
                <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                  {p.items.map((i) => (
                    <li key={i} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />{i}</li>
                  ))}
                </ul>
                <Button asChild className="mt-7" variant={p.highlight ? "default" : "outline"}><Link href="/signup">Start free trial</Link></Button>
              </div>
            ))}
          </div>
        </section>

        <section id="faq" className="border-t">
          <div className="mx-auto max-w-3xl px-4 py-24">
            <h2 className="text-4xl font-semibold tracking-tight">Questions</h2>
            <div className="mt-10 divide-y rounded-lg border bg-card">
              {FAQ.map((f) => (
                <details key={f.q} className="group p-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                    {f.q}
                    <span className="text-muted-foreground transition group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-3 text-sm text-muted-foreground">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t">
          <div className="mx-auto max-w-4xl px-4 py-24 text-center">
            <h2 className="text-4xl font-semibold tracking-tight">Hear from every customer, everywhere.</h2>
            <p className="mx-auto mt-3 max-w-md text-muted-foreground">Start free for 7 days. Connect a channel in minutes.</p>
            <Button asChild size="lg" className="mt-8"><Link href="/signup">Create your workspace <ArrowRight /></Link></Button>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row">
          <Brand />
          <span>© {new Date().getFullYear()} OmniReach</span>
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
