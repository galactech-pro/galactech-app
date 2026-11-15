export interface OrgSettings {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  plan: "free" | "starter" | "growth" | "pro";
  trial_ends_at: string | null;
  timezone: string;
  language: string;
  white_label: boolean;
  custom_domain: string | null;
  whatsapp: { connected: boolean; phone_number_id: string | null; business_account_id: string | null; access_token: string | null };
  email: { connected: boolean; resend_api_key: string | null };
  voice: { elevenlabs_voice_id: string | null };
}

export const SETTINGS_KEY = ["settings"] as const;
