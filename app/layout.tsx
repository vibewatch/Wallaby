import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { cookies } from "next/headers";

import { ServiceWorker } from "@/components/service-worker";
import { parseTheme, THEME_COOKIE, themeAttribute, themeBootstrapScript } from "@/lib/theme";

import "@fontsource-variable/noto-sans-sc/wght.css";
import "./globals.css";

const mona = localFont({
  src: [
    { path: "../node_modules/@fontsource-variable/mona-sans/files/mona-sans-latin-wght-normal.woff2", weight: "200 900", style: "normal" },
    { path: "../node_modules/@fontsource-variable/mona-sans/files/mona-sans-latin-wght-italic.woff2", weight: "200 900", style: "italic" },
  ],
  variable: "--font-mona",
  display: "swap",
});
const mono = localFont({
  src: "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  weight: "100 800",
  variable: "--font-mono",
  display: "swap",
  preload: false,
});

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
    { media: "(prefers-color-scheme: light)", color: "#f5f4ed" },
    { media: "(prefers-color-scheme: dark)", color: "#181816" },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" className={`${mona.variable} ${mono.variable}`} data-scroll-behavior="smooth" data-theme={themeAttribute(theme)} data-theme-preference={theme}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript(theme) }} />
      </head>
      <body>{children}<ServiceWorker /></body>
    </html>
  );
}
