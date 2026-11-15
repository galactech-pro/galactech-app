const isDev = process.env.NODE_ENV !== "production";

/**
 * CSP strategy (audit L-03 / research 01 s6):
 *  - ENFORCED: only the directives that cannot break rendering (clickjacking, <base>, plugins).
 *  - REPORT-ONLY: the full script/style/connect policy. Next 15 emits inline bootstrap scripts, so an enforcing
 *    script-src needs per-request nonces (middleware + dynamic rendering) which we have not adopted. The Report-Only
 *    policy lets you watch the browser console / a report endpoint for violations (Supabase, Razorpay checkout) and
 *    promote it to enforcing once clean. The Razorpay hosts below are from general knowledge: UNVERIFIED, confirm in a
 *    real checkout. Not tested in a browser in this workstream (no running app / DB).
 */
const enforced = ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'"].join("; ");

const reportOnly = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://checkout.razorpay.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "font-src 'self' data:",
  "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
  "frame-src https://api.razorpay.com https://checkout.razorpay.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Content-Security-Policy", value: enforced },
  { key: "Content-Security-Policy-Report-Only", value: reportOnly },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Lets a second dev server (e.g. smoke tests on :3100) run with its own build dir: NEXT_DIST_DIR=.next-smoke
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
export default nextConfig;
