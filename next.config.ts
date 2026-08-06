import type { NextConfig } from "next";
import { PHASE_PRODUCTION_SERVER } from "next/constants";

import { validateProductionEnvironment } from "./lib/production-config";

const development = process.env.NODE_ENV === "development";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  `connect-src 'self'${development ? " ws: wss:" : ""}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Permissions-Policy", value: "browsing-topics=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
];

export default function nextConfig(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_SERVER) {
    const { warnings } = validateProductionEnvironment();
    for (const warning of warnings) console.warn(JSON.stringify({ level: "warn", event: "configuration.warning", message: warning }));
  }

  return {
    deploymentId: process.env.DEPLOYMENT_VERSION?.trim() || undefined,
    poweredByHeader: false,
    reactStrictMode: true,
    experimental: {
      serverActions: {
        bodySizeLimit: "20mb",
      },
    },
    transpilePackages: ["@wallaby/extractor"],
    outputFileTracingIncludes: {
      "/*": [
        "./packages/extractor-site-config/configs/**/*.txt",
        "./node_modules/@fontsource/unifont/files/unifont-latin-400-normal.woff2",
      ],
    },
    async headers() {
      return [
        { source: "/:path*", headers: securityHeaders },
        { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
        { source: "/auth/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
        { source: "/oauth/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
        { source: "/feed/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      ];
    },
  };
}
