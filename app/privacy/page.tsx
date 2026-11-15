import type { Metadata } from "next";
import { LegalPage } from "@/components/app/legal-page";

export const metadata: Metadata = { title: "Privacy Policy | GalacTech" };

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="1 November 2026"
      sections={[
        { h: "1. Who we are", p: ["GalacTech (\"we\", \"us\") provides a customer-engagement platform for WhatsApp, email and AI voice outreach. For the personal data of your own leads and customers that you upload, you are the data fiduciary (controller) and we act as your data processor. For your account data, we are the data fiduciary."] },
        { h: "2. Data we collect", p: ["Account data: name, email, business name, role and login credentials (managed by our authentication provider).", "Customer data you upload or sync: contact names, phone numbers, emails, tags, notes, messages, call recordings and transcripts.", "Usage and technical data: logs, device and browser information, and product analytics used to keep the service secure and reliable."] },
        { h: "3. How we use data", p: ["To provide the service, including sending messages and placing calls on your instruction, scoring leads with AI, generating reports and providing support.", "To bill you, prevent abuse and comply with law. We do not sell personal data."] },
        { h: "4. Legal basis and consent (India DPDP Act)", p: ["We process personal data under the Digital Personal Data Protection Act, 2023 on the basis of consent and legitimate uses permitted by the Act. You are responsible for obtaining valid consent from your contacts before messaging or calling them, and for honouring opt-outs. GalacTech enforces opt-out and Do-Not-Call flags before every send."] },
        { h: "5. Sub-processors", p: ["We use trusted providers to run the service, including Supabase (managed PostgreSQL database), Vercel (hosting), Meta (WhatsApp Cloud API), Resend (email), Vapi, ElevenLabs and Twilio (voice), Google and Anthropic (AI models), Razorpay (payments) and Inngest (background jobs). Some of these process data outside India."] },
        { h: "6. Security and retention", p: ["Integration secrets such as WhatsApp tokens are encrypted at rest with AES-256-GCM, and access to every record is restricted to your organisation. We retain data while your account is active and delete or anonymise it within 90 days after account closure, unless law requires otherwise."] },
        { h: "7. Your rights", p: ["You may access, correct, export or erase your personal data, withdraw consent and nominate another person to exercise rights on your behalf. Contacts of our customers should first contact the business that messaged them. To exercise rights with us, write to the grievance contact below."] },
        { h: "8. Grievance officer", p: ["For privacy questions or complaints, contact privacy@omnireach.ai. We aim to respond within 7 days and resolve grievances within 30 days."] },
        { h: "9. Changes", p: ["We may update this policy and will notify you of material changes by email or in the app."] },
      ]}
    />
  );
}
