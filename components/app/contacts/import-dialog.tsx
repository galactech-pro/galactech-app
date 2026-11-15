"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/fetcher";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { errMsg } from "./types";

interface Preview {
  headers: string[];
  mapping: Record<string, string>;
  fields: string[];
  sample: Record<string, string>[];
  total_rows: number;
}
interface Result {
  created: number;
  duplicates: number;
  invalid: { row: number; reason: string; data: Record<string, string> }[];
  invalid_count: number;
}

const SKIP = "__skip";

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [mapping, setMapping] = React.useState<Record<string, string>>({});
  const [tags, setTags] = React.useState("");
  const [result, setResult] = React.useState<Result | null>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setMapping({});
    setTags("");
    setResult(null);
  };

  const buildForm = (isPreview: boolean) => {
    const fd = new FormData();
    if (file) fd.append("file", file);
    if (isPreview) fd.append("preview", "true");
    else {
      fd.append("mapping", JSON.stringify(mapping));
      if (tags) fd.append("tags", tags);
    }
    return fd;
  };

  const doPreview = useMutation({
    mutationFn: () => api<Preview>("/api/contacts/import", { method: "POST", body: buildForm(true) }),
    onSuccess: (p) => {
      setPreview(p);
      setMapping(p.mapping);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const doImport = useMutation({
    mutationFn: () => api<Result>("/api/contacts/import", { method: "POST", body: buildForm(false) }),
    onSuccess: (r) => {
      setResult(r);
      toast.success(`Imported ${r.created} contacts`);
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: (e) => {
      if (!handleError(e)) toast.error(errMsg(e));
    },
  });

  const mappedFields = new Set(Object.values(mapping));
  const canImport = mappedFields.has("phone") && (mappedFields.has("full_name") || mappedFields.has("first_name"));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import contacts from CSV</DialogTitle>
          <DialogDescription>Max 5 MB / 5,000 rows. Duplicates (same phone) are skipped.</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Imported" value={result.created} />
              <Stat label="Duplicates" value={result.duplicates} />
              <Stat label="Invalid rows" value={result.invalid_count} />
            </div>
            {result.invalid.length > 0 && (
              <div className="max-h-56 overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted text-left">
                    <tr>
                      <th className="p-2">Row</th>
                      <th className="p-2">Reason</th>
                      <th className="p-2">Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.invalid.map((r) => (
                      <tr key={r.row} className="border-t">
                        <td className="p-2">{r.row}</td>
                        <td className="p-2">{r.reason}</td>
                        <td className="max-w-[260px] truncate p-2 text-muted-foreground">{Object.values(r.data).join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : !preview ? (
          <div className="space-y-4">
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground hover:bg-muted/50">
              <Upload className="h-6 w-6" />
              <span>{file ? file.name : "Click to choose a .csv file"}</span>
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <DialogFooter>
              <Button disabled={!file || doPreview.isPending} onClick={() => doPreview.mutate()}>
                {doPreview.isPending ? "Reading..." : "Next: map columns"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{preview.total_rows} rows detected. Map each CSV column to a contact field.</p>
            <div className="space-y-2">
              {preview.headers.map((h) => (
                <div key={h} className="grid grid-cols-2 items-center gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{h}</div>
                    <div className="truncate text-xs text-muted-foreground">{preview.sample[0]?.[h] ?? ""}</div>
                  </div>
                  <Select
                    value={mapping[h] ?? SKIP}
                    onValueChange={(v) =>
                      setMapping((m) => {
                        const n = { ...m };
                        if (v === SKIP) delete n[h];
                        else n[h] = v;
                        return n;
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP}>Skip column</SelectItem>
                      {preview.fields.map((f) => (
                        <SelectItem key={f} value={f}>
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="imp-tags">Tag all imported contacts (optional)</Label>
              <Input id="imp-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="webinar-nov" />
            </div>
            {!canImport && <p className="text-sm text-destructive">Map a phone column and a name column to continue.</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setPreview(null)}>
                Back
              </Button>
              <Button disabled={!canImport || doImport.isPending} onClick={() => doImport.mutate()}>
                {doImport.isPending ? "Importing..." : `Import ${preview.total_rows} rows`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
