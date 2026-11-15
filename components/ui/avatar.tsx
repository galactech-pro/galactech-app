"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const Avatar = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(({ className, ...props }, ref) => (
  <span ref={ref} className={cn("relative flex h-8 w-8 shrink-0 overflow-hidden rounded-full", className)} {...props} />
));
Avatar.displayName = "Avatar";

const AvatarImage = ({ className, src, alt = "", ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
  const [failed, setFailed] = React.useState(false);
  if (!src || failed) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} onError={() => setFailed(true)} className={cn("absolute inset-0 z-10 aspect-square h-full w-full object-cover", className)} {...props} />;
};

const AvatarFallback = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(({ className, ...props }, ref) => (
  <span ref={ref} className={cn("flex h-full w-full items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground", className)} {...props} />
));
AvatarFallback.displayName = "AvatarFallback";

export { Avatar, AvatarImage, AvatarFallback };
