import Link from "next/link";
import { cn } from "@/lib/utils";

/** OmniReach mark: a planet with an orbit ring on a violet→cyan tile. Pure SVG so it is crisp at any size. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("h-7 w-7 shrink-0", className)} aria-hidden>
      <rect width="64" height="64" rx="12" fill="#fff" />
      <circle cx="32" cy="32" r="11" fill="#000" />
      <ellipse cx="32" cy="32" rx="25" ry="9" fill="none" stroke="#000" strokeWidth="3.5" transform="rotate(-24 32 32)" />
      <circle cx="53" cy="22" r="3.2" fill="#00C16A" />
    </svg>
  );
}

export function Wordmark({ className, light }: { className?: string; light?: boolean }) {
  return (
    <span className={cn("text-lg font-semibold tracking-tight", light ? "text-white" : "text-foreground", className)}>
      OmniReach
    </span>
  );
}

export function Brand({ href = "/", light, className }: { href?: string; light?: boolean; className?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2.5", className)} aria-label="OmniReach home">
      <LogoMark />
      <Wordmark light={light} />
    </Link>
  );
}
