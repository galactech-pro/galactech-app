import * as React from "react";
import { Body, Button, Container, Head, Heading, Html, Preview, Section, Text } from "@react-email/components";
import { render } from "@react-email/components";

export type TransactionalKind = "welcome" | "password_reset" | "verify_email" | "invoice" | "trial_ending" | "invite";

// Same tokens as the app (Resend-style dark): black page, #111 card, #333 borders, green only for the primary action.
const FONT = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const s = {
  body: { backgroundColor: "#000000", fontFamily: FONT, margin: 0, padding: "32px 12px" },
  wrap: { maxWidth: 520, margin: "0 auto" },
  brand: { fontSize: 15, fontWeight: 600, color: "#ffffff", margin: "0 0 20px", letterSpacing: "-0.01em" },
  dot: { color: "#00C16A" },
  card: { backgroundColor: "#111111", border: "1px solid #333333", borderRadius: 8, padding: "32px 28px" },
  h1: { fontSize: 22, fontWeight: 600, color: "#ffffff", margin: "0 0 16px", letterSpacing: "-0.01em", lineHeight: "30px" },
  p: { fontSize: 15, lineHeight: "24px", color: "#cccccc", margin: "0 0 14px" },
  btn: { backgroundColor: "#00C16A", color: "#000000", borderRadius: 6, padding: "11px 20px", fontSize: 14, fontWeight: 600, textDecoration: "none", display: "inline-block" },
  foot: { fontSize: 12, color: "#8a8a8a", textAlign: "center" as const, margin: "20px 0 0", lineHeight: "18px" },
};

interface Shell {
  preview: string;
  title: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
}

function Layout({ preview, title, paragraphs, cta }: Shell) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="dark" />
        <meta name="supported-color-schemes" content="dark" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={s.body}>
        <Container style={s.wrap}>
          <Text style={s.brand}>
            <span style={s.dot}>&#9679;</span>&nbsp; GalacTech
          </Text>
          <Section style={s.card}>
            <Heading style={s.h1}>{title}</Heading>
            {paragraphs.map((p, i) => (
              <Text key={i} style={s.p}>
                {p}
              </Text>
            ))}
            {cta ? (
              <Section style={{ margin: "24px 0 4px" }}>
                <Button href={cta.url} style={s.btn}>
                  {cta.label}
                </Button>
              </Section>
            ) : null}
          </Section>
          <Text style={s.foot}>GalacTech &middot; Every channel, one inbox.</Text>
        </Container>
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
