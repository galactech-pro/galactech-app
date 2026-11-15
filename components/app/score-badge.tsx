"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function scoreTone(score: number | null | undefined): "red" | "yellow" | "green" | "grey" {
  if (score == null) return "grey";
  if (score <= 3) return "red";
  if (score <= 6) return "yellow";
  return "green";
}

const TONE: Record<ReturnType<typeof scoreTone>, string> = {
  red: "bg-red-100 text-red-800 ring-red-200",
  yellow: "bg-yellow-100 text-yellow-800 ring-yellow-200",
  green: "bg-green-100 text-green-800 ring-green-200",
  grey: "bg-gray-100 text-gray-500 ring-gray-200",
};

/** AI lead score chip: 1-3 red, 4-6 yellow, 7-10 green, null = grey "–" with the reason (if any) in a tooltip. */
export function ScoreBadge({
  score,
  reason,
  className,
}: {
  score: number | null | undefined;
  reason?: string | null;
  className?: string;
}) {
  const tone = scoreTone(score);
  const chip = (
    <span
      className={cn(
        "inline-flex h-6 min-w-8 items-center justify-center rounded-full px-2 text-xs font-semibold ring-1 ring-inset",
        TONE[tone],
        className
      )}
      aria-label={score == null ? "Not scored yet" : `Lead score ${score} out of 10`}
    >
      {score == null ? "–" : score}
    </span>
  );
  const text = reason || (score == null ? "Not scored yet" : null);
  if (!text) return chip;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {chip}
          </button>
        </TooltipTrigger>
        <TooltipContent>{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
