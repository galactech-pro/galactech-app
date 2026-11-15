import type { ChannelAdapter, ChannelKind } from "./types";
import { whatsappCloudAdapter } from "./adapters/whatsapp";
import { resendEmailAdapter } from "./adapters/email";
import { imapEmailAdapter } from "./adapters/email-imap";
import { vapiVoiceAdapter } from "./adapters/voice";
import { telegramAdapter } from "./adapters/telegram";
import { messengerAdapter, instagramAdapter } from "./adapters/meta";
import { twilioSmsAdapter } from "./adapters/sms-twilio";
import { webchatAdapter } from "./adapters/webchat";
import { apiAdapter } from "./adapters/api";

/**
 * Adapter registry. To add a channel: implement ChannelAdapter, import it here and add it to ADAPTERS.
 * See docs/CHANNELS.md.
 */
const ADAPTERS: ChannelAdapter[] = [
  whatsappCloudAdapter, resendEmailAdapter, imapEmailAdapter, vapiVoiceAdapter,
  telegramAdapter, messengerAdapter, instagramAdapter, twilioSmsAdapter, webchatAdapter, apiAdapter,
];

const map = new Map<string, ChannelAdapter>(ADAPTERS.map((a) => [`${a.channel}:${a.provider}`, a]));

const DEFAULT_PROVIDER: Partial<Record<ChannelKind, string>> = {
  whatsapp: "whatsapp_cloud",
  email: "resend",
  voice: "vapi",
  sms: "twilio",
  telegram: "telegram_bot",
  messenger: "meta_graph",
  instagram: "meta_graph",
  webchat: "webchat",
  api: "api",
};

export function defaultProvider(channel: ChannelKind): string {
  return DEFAULT_PROVIDER[channel] ?? "default";
}

export function getAdapter(channel: ChannelKind, provider?: string): ChannelAdapter {
  const a = map.get(`${channel}:${provider ?? defaultProvider(channel)}`);
  if (!a) throw new Error(`No channel adapter registered for ${channel}:${provider ?? defaultProvider(channel)}`);
  return a;
}

export function findAdapter(channel: ChannelKind, provider?: string): ChannelAdapter | null {
  return map.get(`${channel}:${provider ?? defaultProvider(channel)}`) ?? null;
}

/** Channels that have at least one adapter able to send. Campaign creation/validation uses this. */
export function outboundChannels(): ChannelKind[] {
  const s = new Set<ChannelKind>();
  for (const a of ADAPTERS) if (a.capabilities().supportsOutbound) s.add(a.channel);
  return [...s];
}

export function supportsOutbound(channel: ChannelKind): boolean {
  return outboundChannels().includes(channel);
}

export function allAdapters(): readonly ChannelAdapter[] {
  return ADAPTERS;
}
