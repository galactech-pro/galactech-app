"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/fetcher";

export interface PickedContact { id: string; full_name: string; company?: string | null }

/** Search-as-you-type contact selector (used by new deal / new task). */
export function ContactPicker({ value, onChange, placeholder = "Search contacts by name, phone or email" }: { value: PickedContact | null; onChange: (c: PickedContact | null) => void; placeholder?: string }) {
  const [q, setQ] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const res = useQuery({
    queryKey: ["contact-picker", debounced],
    queryFn: () => api<{ items: PickedContact[] }>(`/api/contacts?page_size=6&q=${encodeURIComponent(debounced)}`),
    enabled: !value && debounced.length >= 2,
  });

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border bg-secondary/40 px-3 py-2 text-sm">
        <span className="flex min-w-0 items-center gap-2"><Check className="h-4 w-4 shrink-0 text-primary" /><span className="truncate">{value.full_name}{value.company ? `, ${value.company}` : ""}</span></span>
        <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Clear contact" onClick={() => onChange(null)}><X className="h-4 w-4" /></button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label="Search contacts" />
      {debounced.length >= 2 ? (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover p-1 shadow-menu">
          {res.isLoading ? <li className="px-2 py-1.5 text-sm text-muted-foreground">Searching...</li> : null}
          {res.data && res.data.items.length === 0 ? <li className="px-2 py-1.5 text-sm text-muted-foreground">No contacts found</li> : null}
          {res.data?.items.map((c) => (
            <li key={c.id}>
              <button type="button" className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-secondary" onClick={() => { onChange({ id: c.id, full_name: c.full_name, company: c.company }); setQ(""); }}>
                {c.full_name}{c.company ? <span className="text-muted-foreground">, {c.company}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
