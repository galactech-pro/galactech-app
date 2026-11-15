import type { Metadata } from "next";
import { LegalPage } from "@/components/app/legal-page";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="1 November 2026"
      sections={[
        { h: "1. Agreement", p: ["By creating an account or using GalacTech you agree to these Terms. If you use the service on behalf of a business, you confirm you have authority to bind it."] },
        { h: "2. The service", p: ["GalacTech lets you manage contacts and send WhatsApp messages, emails and AI-assisted voice calls, and automate follow-ups. Features and limits depend on your plan. New accounts receive a 7-day free trial; after it ends, sending is paused until you subscribe."] },
        { h: "3. Acceptable use and compliance", p: ["You must only contact people who have given valid consent, and must honour opt-out and Do-Not-Call requests immediately. You agree to comply with applicable law, including the DPDP Act 2023, the IT Act 2000, the TRAI Telecom Commercial Communications Customer Preference Regulations (including DLT registration and the National Customer Preference Register where applicable), and the WhatsApp Business and Meta commercial messaging policies.", "You must not send spam, unlawful, deceptive or harassing content, impersonate others, or use the service to collect sensitive data without lawful basis. We may suspend accounts that put the platform, our providers or other users at risk."] },
        { h: "4. AI features", p: ["AI-generated messages, scores and call summaries can be inaccurate. You are responsible for reviewing content and for the messages and calls sent from your account. AI voice calls must identify themselves as automated where required by law."] },
        { h: "5. Fees and billing", p: ["Paid plans are billed in Indian Rupees through Razorpay, monthly or annually in advance, and include applicable GST. Plans renew automatically until cancelled. You can cancel at any time and keep access until the end of the paid period. Fees are non-refundable except where required by law."] },
        { h: "6. Your data", p: ["You own your data. You grant us a limited licence to process it to provide the service as described in our Privacy Policy. You can export or delete your data at any time."] },
        { h: "7. Third-party services", p: ["The service depends on third parties such as Meta, email and telephony providers. We are not responsible for their outages, policy changes or enforcement actions, including WhatsApp number restrictions."] },
        { h: "8. Disclaimer and liability", p: ["The service is provided \"as is\". To the extent permitted by law, our total liability for any claim is limited to the fees you paid in the three months before the claim, and we are not liable for indirect or consequential loss."] },
        { h: "9. Governing law", p: ["These Terms are governed by the laws of India. Courts at Bengaluru, Karnataka have exclusive jurisdiction, subject to any mandatory consumer protections."] },
        { h: "10. Contact", p: ["Questions about these Terms: legal@omnireach.ai."] },
      ]}
    />
  );
}
