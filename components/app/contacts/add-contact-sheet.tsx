"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/fetcher";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { errMsg } from "./types";

export function AddContactSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const [f, setF] = React.useState({ full_name: "", phone: "", email: "", company: "", job_title: "", tags: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: () =>
      api("/api/contacts", {
        method: "POST",
        json: {
          full_name: f.full_name,
          phone: f.phone,
          email: f.email || null,
          company: f.company || null,
          job_title: f.job_title || null,
          tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
        },
      }),
    onSuccess: () => {
      toast.success("Contact added");
      void qc.invalidateQueries({ queryKey: ["contacts"] });
      setF({ full_name: "", phone: "", email: "", company: "", job_title: "", tags: "" });
      onOpenChange(false);
    },
    onError: (e) => {
      if (!handleError(e)) toast.error(errMsg(e));
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add contact</SheetTitle>
          <SheetDescription>Phone numbers are normalised to +91 if no country code is given.</SheetDescription>
        </SheetHeader>
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="ac-name">Full name *</Label>
            <Input id="ac-name" required value={f.full_name} onChange={set("full_name")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ac-phone">Phone *</Label>
            <Input id="ac-phone" required value={f.phone} onChange={set("phone")} placeholder="98765 43210" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ac-email">Email</Label>
            <Input id="ac-email" type="email" value={f.email} onChange={set("email")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ac-company">Company</Label>
              <Input id="ac-company" value={f.company} onChange={set("company")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ac-title">Job title</Label>
              <Input id="ac-title" value={f.job_title} onChange={set("job_title")} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ac-tags">Tags (comma separated)</Label>
            <Input id="ac-tags" value={f.tags} onChange={set("tags")} placeholder="vip, webinar" />
          </div>
          <Button type="submit" className="w-full" disabled={create.isPending}>
            {create.isPending ? "Saving..." : "Add contact"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
