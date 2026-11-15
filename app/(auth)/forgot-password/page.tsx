"use client";

import * as React from "react";
import Link from "next/link";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FormAlert, SubmitButton } from "@/components/app/auth-bits";
import { api } from "@/lib/fetcher";

const schema = z.object({ email: z.string().trim().email("Enter a valid email") });
type Values = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [state, setState] = React.useState<{ kind: "error" | "success"; text: string } | null>(null);
  const {
    register, handleSubmit, formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(v: Values) {
    setState(null);
    try {
      await api("/api/auth/forgot", { method: "POST", json: { email: v.email } });
      setState({ kind: "success", text: "If an account exists for that email, a reset link is on its way." });
    } catch (e) {
      setState({ kind: "error", text: e instanceof Error ? e.message : "Something went wrong." });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Reset your password</CardTitle>
        <CardDescription>Enter your email and we&apos;ll send you a reset link.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {state ? <FormAlert kind={state.kind}>{state.text}</FormAlert> : null}
          <Field id="email" label="Email" type="email" autoComplete="email" error={errors.email?.message} {...register("email")} />
          <SubmitButton loading={isSubmitting}>Send reset link</SubmitButton>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/login" className="text-primary hover:underline">Back to sign in</Link>
        </p>
      </CardContent>
    </Card>
  );
}
