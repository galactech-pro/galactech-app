"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FormAlert, SubmitButton } from "@/components/app/auth-bits";
import { api } from "@/lib/fetcher";

const schema = z.object({
  full_name: z.string().trim().min(2, "Enter your name").max(120),
  org_name: z.string().trim().max(120).optional(),
  email: z.string().trim().email("Enter a valid email"),
  password: z
    .string()
    .min(8, "At least 8 characters")
    .regex(/[A-Za-z]/, "Include a letter")
    .regex(/\d/, "Include a number"),
});
type Values = z.infer<typeof schema>;

function SignupForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const inviteToken = sp.get("invite");
  const inviteEmail = inviteToken ? (sp.get("email") ?? "") : "";
  const [error, setError] = React.useState<string | null>(null);
  const {
    register, handleSubmit, setError: setFieldError, formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: inviteEmail } });

  async function onSubmit(v: Values) {
    setError(null);
    if (!inviteToken && (!v.org_name || v.org_name.length < 2)) {
      return setFieldError("org_name", { message: "Enter your business name" });
    }
    try {
      await api("/api/auth/signup", {
        method: "POST",
        json: { full_name: v.full_name, org_name: v.org_name, email: v.email, password: v.password, invite: inviteToken ?? undefined },
      });
    } catch (e) {
      return setError(e instanceof Error ? e.message : "Could not create your account.");
    }
    router.replace(inviteToken ? "/dashboard" : "/onboarding");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Start your 7-day free trial</CardTitle>
        <CardDescription>No credit card required.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {error ? <FormAlert>{error}</FormAlert> : null}
          <Field id="full_name" label="Your name" autoComplete="name" error={errors.full_name?.message} {...register("full_name")} />
          {inviteToken ? null : (
            <Field id="org_name" label="Business name" autoComplete="organization" error={errors.org_name?.message} {...register("org_name")} />
          )}
          <Field id="email" label="Work email" type="email" autoComplete="email" readOnly={!!inviteToken} error={errors.email?.message} {...register("email")} />
          <Field id="password" label="Password" type="password" autoComplete="new-password" error={errors.password?.message} {...register("password")} />
          <SubmitButton loading={isSubmitting}>Create account</SubmitButton>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline underline-offset-2 hover:no-underline">Sign in</Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default function SignupPage() {
  return (
    <React.Suspense>
      <SignupForm />
    </React.Suspense>
  );
}
