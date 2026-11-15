"use client";

import * as React from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CopyButton } from "@/components/app/settings/connections-tab";
import { api } from "@/lib/fetcher";

type Tab = "link" | "html" | "wordpress" | "shopify" | "builders" | "gtm" | "react";
const TABS: { id: Tab; label: string }[] = [
  { id: "link", label: "Link and QR" },
  { id: "html", label: "Any website" },
  { id: "wordpress", label: "WordPress" },
  { id: "shopify", label: "Shopify" },
  { id: "builders", label: "Wix, Squarespace, Webflow" },
  { id: "gtm", label: "Google Tag Manager" },
  { id: "react", label: "React or Next.js" },
];

function Code({ value }: { value: string }) {
  return (
    <div className="flex gap-2">
      <Input readOnly value={value} className="h-8 font-mono text-xs" aria-label="Code to copy" />
      <CopyButton value={value} />
    </div>
  );
}

function Qr({ url }: { url: string }) {
  const [img, setSvg] = React.useState<string>("");
  React.useEffect(() => {
    let live = true;
    QRCode.toDataURL(url, { margin: 1, width: 480, color: { dark: "#000000", light: "#ffffff" } }).then((s) => live && setSvg(s)).catch(() => undefined);
    return () => { live = false; };
  }, [url]);
  const download = () => {
    const a = document.createElement("a");
    a.href = img;
    a.download = "chat-qr.png";
    a.click();
  };
  if (!img) return null;
  return (
    <div className="flex items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img} alt="QR code for the chat link" width={120} height={120} className="rounded-md bg-white" />
      <Button size="sm" variant="outline" onClick={download}>Download QR</Button>
    </div>
  );
}

function Verify({ inboxId }: { inboxId: string }) {
  const [url, setUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [res, setRes] = React.useState<{ verdict: string; token_found: boolean; site_allowed: boolean } | null>(null);
  const [err, setErr] = React.useState("");
  const run = async () => {
    setBusy(true); setErr(""); setRes(null);
    try {
      setRes(await api<{ verdict: string; token_found: boolean; site_allowed: boolean }>("/api/channels/verify", { method: "POST", json: { id: inboxId, url } }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-sm font-medium">Check that it is installed</p>
      <div className="flex gap-2">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.yourcompany.com" aria-label="Page to check" onKeyDown={(e) => e.key === "Enter" && url.trim() && run()} />
        <Button size="sm" variant="outline" disabled={busy || !url.trim()} onClick={run}>{busy ? "Checking" : "Check"}</Button>
      </div>
      {err ? <p className="text-xs text-destructive">{err}</p> : null}
      {res ? <p className={res.token_found && res.site_allowed ? "text-xs text-primary" : "text-xs text-amber-400"}>{res.verdict}</p> : null}
    </div>
  );
}

export function InstallDialog({ inboxId, chatUrl, snippet, token }: { inboxId: string; chatUrl: string; snippet: string; token: string }) {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<Tab>("link");
  const host = React.useMemo(() => { try { return new URL(chatUrl).origin; } catch { return ""; } }, [chatUrl]);
  const react = `import Script from "next/script";\n\n// put this inside your root layout, before </body>\n<Script src="${host}/webchat.js" data-token="${token}" strategy="afterInteractive" />`;

  return (
    <>
      <Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(true)}>Install on your site</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add chat to your customers' reach</DialogTitle>
            <DialogDescription>Pick what fits. Every option sends messages to your Inbox.</DialogDescription>
          </DialogHeader>
          <div role="tablist" aria-label="Install options" className="flex flex-wrap gap-1.5">
            {TABS.map((t) => (
              <Button key={t.id} role="tab" aria-selected={tab === t.id} size="sm" variant={tab === t.id ? "default" : "outline"} className="h-7" onClick={() => setTab(t.id)}>{t.label}</Button>
            ))}
          </div>
          <div className="space-y-3 text-sm" role="tabpanel">
            {tab === "link" ? (
              <>
                <p className="text-muted-foreground">No install at all. Share this link in an Instagram bio, email signature, WhatsApp status, a "Contact us" button, or print the QR code on a counter, receipt or flyer.</p>
                <Code value={chatUrl} />
                <Qr url={chatUrl} />
                <Button asChild size="sm" variant="outline"><a href={chatUrl} target="_blank" rel="noopener noreferrer">Open the chat page</a></Button>
              </>
            ) : null}
            {tab === "html" ? (
              <>
                <p className="text-muted-foreground">Paste this just before the closing <code>&lt;/body&gt;</code> tag of your pages. Then add the website address under allowed websites for this channel.</p>
                <Code value={snippet} />
                <p className="text-xs text-muted-foreground">
                  It adds a small tab on the middle of the screen edge (clear of corner icons such as WhatsApp) and invites visitors with a centered pop-up once a day. Add <code>data-side="left"</code> to dock it on the left, or <code>data-popup="off"</code> to turn the pop-up off. If your site uses a strict Content Security Policy, allow this address for scripts and frames.
                </p>
              </>
            ) : null}
            {tab === "wordpress" ? (
              <>
                <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                  <li>Download the plugin below.</li>
                  <li>In WordPress: Plugins, Add New, Upload Plugin, choose the file, Install, Activate.</li>
                  <li>Open Settings, OmniReach Chat, paste this token and save.</li>
                </ol>
                <Code value={token} />
                <Button asChild size="sm" variant="outline"><a href="/omnireach-chat-wordpress.zip" download>Download WordPress plugin</a></Button>
                <p className="text-xs text-muted-foreground">Prefer no plugin? Use a free "header and footer" plugin such as WPCode and paste the code from "Any website".</p>
              </>
            ) : null}
            {tab === "shopify" ? (
              <>
                <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                  <li>Online Store, Themes, the three dots, Edit code.</li>
                  <li>Open <code>layout/theme.liquid</code>.</li>
                  <li>Paste this just above <code>&lt;/body&gt;</code> and save.</li>
                </ol>
                <Code value={snippet} />
              </>
            ) : null}
            {tab === "builders" ? (
              <>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  <li><strong>Wix:</strong> Settings, Custom code, Add code, paste, place in Body end, All pages.</li>
                  <li><strong>Squarespace:</strong> Settings, Advanced, Code Injection, Footer.</li>
                  <li><strong>Webflow:</strong> Project settings, Custom code, Footer code, then publish.</li>
                  <li><strong>Others (Weebly, Ghost, Framer):</strong> look for "custom code" or "footer code".</li>
                </ul>
                <Code value={snippet} />
              </>
            ) : null}
            {tab === "gtm" ? (
              <>
                <p className="text-muted-foreground">If the site already uses Google Tag Manager: Tags, New, Custom HTML, paste this, trigger on All Pages, then Submit.</p>
                <Code value={snippet} />
              </>
            ) : null}
            {tab === "react" ? (
              <>
                <p className="text-muted-foreground">For a React, Next.js or any developer-built site.</p>
                <pre className="max-h-48 overflow-auto rounded-md border bg-card p-3 text-xs">{react}</pre>
                <CopyButton value={react} />
              </>
            ) : null}
            {tab !== "link" ? <Verify inboxId={inboxId} /> : null}
            <p className="border-t pt-3 text-xs text-muted-foreground">Floating bubble options (every tab except Link and QR) only work on websites listed as allowed for this channel.</p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
