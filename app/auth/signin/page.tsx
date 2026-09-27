import { BookOpenText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { SignInForm } from "@/components/sign-in-form";
import { isPasswordResetAvailable } from "@/lib/password-reset";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string; reset?: string }> }) {
  const { callbackUrl, reset } = await searchParams;
  return (
    <main className="signin-page">
      <section className="signin-story" aria-label="About Wallaby">
        <div className="brand-mark light-mark"><BookOpenText size={22} strokeWidth={1.8} /></div>
        <p className="eyebrow light-eyebrow">Your reading, on your terms</p>
        <h1>Keep the web<br />worth keeping.</h1>
        <p className="signin-intro">Wallaby saves clean, readable copies of articles so your attention belongs to the words—not the page around them.</p>
        <div className="signin-quote">
          <span>“</span>
          <p>A library is not a luxury but one of the necessities of life.</p>
          <small>Henry Ward Beecher</small>
        </div>
      </section>
      <section className="signin-panel">
        <div className="signin-box">
          <p className="eyebrow">Welcome back</p>
          <h2>Enter your library</h2>
          <p className="muted">Sign in to continue to your saved reading.</p>
          {reset === "1" ? <p className="signin-notice" role="status">Your password was changed. Sign in with the new one.</p> : null}
          <SignInForm callbackUrl={callbackUrl} />
          {isPasswordResetAvailable() ? <Link className="signin-link" href="/auth/forgot">Forgot your password?</Link> : null}
          {/* A deployed instance must not advertise the seed account's password. */}
          {process.env.NODE_ENV !== "production" ? <p className="demo-hint">Local demo: <strong>demo</strong> / <strong>wallaby-demo</strong></p> : null}
        </div>
        <p className="privacy-note">Self-hosted · Private by design · No tracking</p>
      </section>
    </main>
  );
}
