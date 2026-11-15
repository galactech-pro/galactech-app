import { Globe, Instagram, Mail, MessageCircle, MessageSquare, MessagesSquare, Phone, Send, Webhook } from "lucide-react";
import type { Channel } from "./types";

const ICONS = { whatsapp: MessageCircle, email: Mail, voice: Phone, sms: MessageSquare, telegram: Send, instagram: Instagram, messenger: MessagesSquare, webchat: Globe, api: Webhook };
const LABELS: Record<Channel, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  voice: "Voice",
  sms: "SMS",
  telegram: "Telegram",
  instagram: "Instagram",
  messenger: "Messenger",
  webchat: "Web chat",
  api: "API",
};

export function ChannelIcon({ channel, className = "h-4 w-4" }: { channel: Channel; className?: string }) {
  const I = ICONS[channel] ?? MessageSquare;
  return <I className={className} aria-label={LABELS[channel] ?? channel} />;
}
export const channelLabel = (c: Channel) => LABELS[c] ?? c;
