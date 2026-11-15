"use client";

import * as React from "react";
import Link from "next/link";
import { safeNextPath } from "@/lib/safe-redirect";
import { useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FormAlert, SubmitButton } from "@/components/app/auth-bits";
import { api } from "@/lib/fetcher";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});
type Values = z.infer<typeof schema>;

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const rawNext = params.get("next") ?? "/dashboard";
  const next = safeNextPath(rawNext, "/dashboard");
  const [error, setError] = React.useState<string | null>(params.get("error"));
  const {
    register, handleSubmit, formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(v: Values) {
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", json: v });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in.");
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Welcome back</CardTitle>
        <CardDescription>Sign in to your GalacTech workspace.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {error ? <FormAlert>{error}</FormAlert> : null}
          <Field id="email" label="Email" type="email" autoComplete="email" error={errors.email?.message} {...register("email")} />
          <Field
            id="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            error={errors.password?.message}
            hint={<Link href="/forgot-password" className="text-xs text-primary hover:underline">Forgot password?</Link>}
            {...register("password")}
          />
          <SubmitButton loading={isSubmitting}>Sign in</SubmitButton>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          New to GalacTech?{" "}
          <Link href="/signup" className="font-medium text-primary hover:underline">Start your free trial</Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <React.Suspense>
      <LoginForm />
    </React.Suspense>
  );
}
