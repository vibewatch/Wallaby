import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Wallaby", template: "%s · Wallaby" },
  description: "A quiet, self-hosted home for the articles you want to keep.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
