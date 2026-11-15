"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function FormAlert({ kind = "error", children }: { kind?: "error" | "success"; children: React.ReactNode }) {
  if (!children) return null;
  const Icon = kind === "error" ? AlertCircle : CheckCircle2;
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        kind === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-green-200 bg-green-50 text-green-800"
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function Field({
  id, label, error, hint, ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; error?: string; hint?: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        {hint}
      </div>
      <Input id={id} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} {...props} />
      {error ? (
        <p id={`${id}-err`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SubmitButton({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  return (
    <Button type="submit" variant="brand" className="w-full" disabled={loading}>
      {loading ? <Loader2 className="animate-spin" /> : null}
      {children}
    </Button>
  );
}

export function OrDivider() {
  return (
    <div className="relative my-1 text-center text-xs uppercase text-muted-foreground">
      <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
      <span className="relative bg-card px-2">or</span>
    </div>
  );
}
