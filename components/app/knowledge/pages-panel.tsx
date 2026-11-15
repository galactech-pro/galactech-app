"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/fetcher";

export interface CrawlReport {
  sitemap: string | null;
  sitemap_urls: number;
  via_links: boolean;
  discovered: number;
  read: number;
  failed: string[];
  thin: string[];
  contact_found: boolean;
}

const short = (u: string) => (u.includes("#contact") ? "Contact details and links" : u.replace(/^https?:\/\/[^/]+/, "") || "/");

/** One-line explanation of how the site was found and read, with honest warnings. */
export function CrawlSummary({ r }: { r: CrawlReport }) {
  return (
    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      <p>
        {r.sitemap ? `Sitemap found (${r.sitemap_urls} pages listed).` : "No sitemap found, so links were followed from the home page."} Read {r.read} of {r.discovered} pages.
        {r.contact_found ? " Contact details captured." : " No phone or email found on the site."}
      </p>
      {r.thin.length ? <p className="text-amber-400">{r.thin.length} page{r.thin.length === 1 ? "" : "s"} had very little readable text (the site may load content with JavaScript). Add those details as a note below.</p> : null}
      {r.failed.length ? <p className="text-amber-400">{r.failed.length} page{r.failed.length === 1 ? "" : "s"} could not be opened.</p> : null}
    </div>
  );
}

/** Lists every page the AI read from a source and shows the extracted text on demand. */
export function PagesPanel({ sourceId }: { sourceId: string }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const list = useQuery({ queryKey: ["kb-pages", sourceId], queryFn: () => api<{ hidden: boolean; pages: { url: string; title: string; sections: number; chars: number }[] }>(`/api/knowledge/${sourceId}/pages`) });
  const text = useQuery({
    queryKey: ["kb-page", sourceId, open],
    enabled: !!open,
    queryFn: () => api<{ title: string; text: string }>(`/api/knowledge/${sourceId}/pages?url=${encodeURIComponent(open as string)}`),
  });
  if (list.isLoading) return <Skeleton className="mt-2 h-16 w-full" />;
  if (list.isError) return <p className="mt-2 text-xs text-destructive">Could not load the pages.</p>;
  if (list.data?.hidden) return <p className="mt-2 text-xs text-muted-foreground">Private knowledge is not displayed.</p>;
  const pages = list.data?.pages ?? [];
  if (!pages.length) return <p className="mt-2 text-xs text-muted-foreground">Nothing has been read yet.</p>;
  return (
    <div className="mt-2 rounded-md border">
      <ul className="max-h-64 divide-y overflow-y-auto text-xs">
        {pages.map((p) => (
          <li key={p.url}>
            <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/50" onClick={() => setOpen(open === p.url ? null : p.url)} aria-expanded={open === p.url}>
              <span className="min-w-0">
                <span className="block truncate font-medium">{p.title || short(p.url)}</span>
                <span className="block truncate text-muted-foreground">{short(p.url)}</span>
              </span>
              <span className="shrink-0 text-muted-foreground">{p.sections} sections, {Math.round(p.chars / 100) / 10}k characters</span>
            </button>
            {open === p.url ? (
              <div className="border-t bg-background px-3 py-2">
                {text.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs text-muted-foreground">{text.data?.text ?? "No text"}</pre>}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
