"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FormAlert, SubmitButton } from "@/components/app/auth-bits";
import { api } from "@/lib/fetcher";

const schema = z
  .object({
    password: z.string().min(8, "At least 8 characters").regex(/[A-Za-z]/, "Include a letter").regex(/\d/, "Include a number"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords do not match" });
type Values = z.infer<typeof schema>;

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [error, setError] = React.useState<string | null>(null);
  const {
    register, handleSubmit, formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(v: Values) {
    setError(null);
    try {
      await api("/api/auth/reset", { method: "POST", json: { token, password: v.password } });
    } catch (e) {
      return setError(e instanceof Error ? e.message : "Could not reset your password.");
    }
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Choose a new password</CardTitle>
        <CardDescription>You&apos;ll be signed in once it&apos;s saved.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {error ? <FormAlert>{error}</FormAlert> : null}
          <Field id="password" label="New password" type="password" autoComplete="new-password" error={errors.password?.message} {...register("password")} />
          <Field id="confirm" label="Confirm password" type="password" autoComplete="new-password" error={errors.confirm?.message} {...register("confirm")} />
          <SubmitButton loading={isSubmitting}>Update password</SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <React.Suspense>
      <ResetForm />
    </React.Suspense>
  );
}
