import * as React from "react";
import { Body, Button, Container, Head, Heading, Html, Preview, Section, Text } from "@react-email/components";
import { render } from "@react-email/components";

export type TransactionalKind = "welcome" | "password_reset" | "verify_email" | "invoice" | "trial_ending" | "invite";

const s = {
  body: { backgroundColor: "#f6f7fb", fontFamily: "Inter, Arial, sans-serif", margin: 0, padding: "24px 0" },
  card: { backgroundColor: "#ffffff", borderRadius: 12, padding: 32, maxWidth: 520, margin: "0 auto" },
  h1: { fontSize: 22, color: "#111827", margin: "0 0 16px" },
  p: { fontSize: 15, lineHeight: "24px", color: "#374151", margin: "0 0 12px" },
  btn: { backgroundColor: "#4f46e5", color: "#ffffff", borderRadius: 8, padding: "12px 20px", fontSize: 15, textDecoration: "none" },
  foot: { fontSize: 12, color: "#9ca3af", textAlign: "center" as const, marginTop: 16 },
};

interface Shell {
  preview: string;
  title: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
}

function Layout({ preview, title, paragraphs, cta }: Shell) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={s.body}>
        <Container style={s.card}>
          <Heading style={s.h1}>{title}</Heading>
          {paragraphs.map((p, i) => (
            <Text key={i} style={s.p}>
              {p}
            </Text>
          ))}
          {cta ? (
            <Section style={{ margin: "20px 0" }}>
              <Button href={cta.url} style={s.btn}>
                {cta.label}
              </Button>
            </Section>
          ) : null}
        </Container>
        <Text style={s.foot}>GalacTech</Text>
      </Body>
    </Html>
  );
}

const str = (v: unknown, d = ""): string => (typeof v === "string" || typeof v === "number" ? String(v) : d);
const appUrl = () => process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export function buildTransactional(kind: TransactionalKind, data: Record<string, unknown>): { subject: string; shell: Shell } {
  const name = str(data.name, "there");
  switch (kind) {
    case "welcome":
      return {
        subject: "Welcome to GalacTech",
        shell: {
          preview: "Your 7-day free trial has started",
          title: `Welcome, ${name}!`,
          paragraphs: [
            "Your 7-day free trial has started. Connect WhatsApp, import your contacts and launch your first campaign in minutes.",
          ],
          cta: { label: "Open dashboard", url: `${appUrl()}/dashboard` },
        },
      };
    case "verify_email":
      return {
        subject: "Confirm your email for GalacTech",
        shell: {
          preview: "Confirm your email address",
          title: "Confirm your email",
          paragraphs: [`Hi ${name}, please confirm your email address to finish setting up your account. The link works for 24 hours.`],
          cta: { label: "Confirm email", url: str(data.url, `${appUrl()}/login`) },
        },
      };
    case "password_reset":
      return {
        subject: "Reset your GalacTech password",
        shell: {
          preview: "Reset your password",
          title: "Reset your password",
          paragraphs: ["We received a request to reset your password. If this was not you, you can ignore this email."],
          cta: { label: "Reset password", url: str(data.url, `${appUrl()}/forgot-password`) },
        },
      };
    case "invoice":
      return {
        subject: `Your GalacTech invoice${data.invoice_id ? ` ${str(data.invoice_id)}` : ""}`,
        shell: {
          preview: "Payment received - thank you",
          title: "Payment received",
          paragraphs: [
            `Hi ${name}, thanks for your payment${data.amount ? ` of INR ${str(data.amount)}` : ""}${data.plan ? ` for the ${str(data.plan)} plan` : ""}.`,
            "You can download your invoice from the billing page.",
          ],
          cta: { label: "View billing", url: str(data.url, `${appUrl()}/settings/billing`) },
        },
      };
    case "trial_ending": {
      const day = Number(data.day ?? 5);
      const left = Math.max(0, 7 - day);
      return {
        subject: day >= 7 ? "Your GalacTech trial ends today" : `Your GalacTech trial ends in ${left} day${left === 1 ? "" : "s"}`,
        shell: {
          preview: "Upgrade to keep your automations running",
          title: day >= 7 ? "Last day of your trial" : "Your trial is ending soon",
          paragraphs: [
            `Hi ${name}, ${day >= 7 ? "your free trial ends today" : `your free trial ends in ${left} day${left === 1 ? "" : "s"}`}. Upgrade now to keep your campaigns, automations and AI calling running.`,
          ],
          cta: { label: "Choose a plan", url: `${appUrl()}/settings/billing` },
        },
      };
    }
    case "invite":
      return {
        subject: `${str(data.inviter, "A teammate")} invited you to ${str(data.org, "GalacTech")}`,
        shell: {
          preview: "You have been invited to join a team",
          title: "You are invited",
          paragraphs: [`${str(data.inviter, "A teammate")} invited you to join ${str(data.org, "their workspace")} as ${str(data.role, "member")}.`],
          cta: { label: "Accept invite", url: str(data.url, appUrl()) },
        },
      };
  }
}

export async function renderShell(shell: Shell): Promise<string> {
  return await render(<Layout {...shell} />);
}

/** Wrap arbitrary body text/HTML in the branded layout (used by automations and reports). */
export async function renderSimple(title: string, paragraphs: string[], cta?: { label: string; url: string }): Promise<string> {
  return renderShell({ preview: title, title, paragraphs, cta });
}
