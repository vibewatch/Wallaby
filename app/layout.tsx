import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";

import { ServiceWorker } from "@/components/service-worker";
import { parseTheme, THEME_COOKIE, themeAttribute, themeBootstrapScript } from "@/lib/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Wallaby", template: "%s · Wallaby" },
  description: "A quiet, self-hosted home for the articles you want to keep.",
  applicationName: "Wallaby",
  appleWebApp: { capable: true, title: "Wallaby", statusBarStyle: "default" },
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f5ef" },
    { media: "(prefers-color-scheme: dark)", color: "#16171a" },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-scroll-behavior="smooth" data-theme={themeAttribute(theme)} data-theme-preference={theme}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript(theme) }} />
      </head>
      <body>{children}<ServiceWorker /></body>
    </html>
  );
}
