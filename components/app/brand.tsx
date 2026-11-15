import Link from "next/link";
import { cn } from "@/lib/utils";

/** GalacTech mark: a planet with an orbit ring on a violet→cyan tile. Pure SVG so it is crisp at any size. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("h-8 w-8 shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id="gt-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c5cff" />
          <stop offset="1" stopColor="#14c8e8" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#gt-g)" />
      <circle cx="32" cy="32" r="11" fill="#fff" />
      <ellipse cx="32" cy="32" rx="25" ry="9" fill="none" stroke="#fff" strokeOpacity=".9" strokeWidth="3.5" transform="rotate(-24 32 32)" />
      <circle cx="53" cy="22" r="3.2" fill="#fff" />
    </svg>
  );
}

export function Wordmark({ className, light }: { className?: string; light?: boolean }) {
  return (
    <span className={cn("font-display text-lg font-bold tracking-tight", light ? "text-white" : "text-foreground", className)}>
      Galac<span className="text-gradient">Tech</span>
    </span>
  );
}

export function Brand({ href = "/", light, className }: { href?: string; light?: boolean; className?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2.5", className)} aria-label="GalacTech home">
      <LogoMark />
      <Wordmark light={light} />
    </Link>
  );
}
