import { ArrowDownToLine, BookOpenText, Highlighter, LockKeyhole } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { SignInForm } from "@/components/sign-in-form";
import { isPasswordResetAvailable } from "@/lib/password-reset";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string; reset?: string }> }) {
  const { callbackUrl, reset } = await searchParams;
  return (
    <main className="signin-page" id="main-content">
      <section className="signin-story" aria-label="About Wallaby">
        <Link className="signin-brand" href="/"><span className="brand-mark light-mark"><BookOpenText size={22} strokeWidth={1.8} /></span>wallaby<span className="brand-caption">A personal reading space</span></Link>
        <p className="eyebrow light-eyebrow">Less noise. More perspective.</p>
        <h1>A home for<br />your <em>next idea.</em></h1>
        <p className="signin-intro">Keep what catches your attention.<br />Come back with room to think.</p>
        <div className="signin-features">
          <span><BookOpenText size={18} /> Read without the noise</span>
          <span><Highlighter size={18} /> Make the ideas your own</span>
          <span><ArrowDownToLine size={18} /> Keep a portable library</span>
        </div>
        <p className="signin-edition">YOUR WEB. THOUGHTFULLY COLLECTED.</p>
      </section>
      <section className="signin-panel">
        <div className="signin-box">
          <p className="eyebrow">Welcome back</p>
          <h2>Your library awaits.</h2>
          <p className="muted">Sign in to continue to your saved reading.</p>
          {reset === "1" ? <p className="signin-notice" role="status">Your password was changed. Sign in with the new one.</p> : null}
          <SignInForm callbackUrl={callbackUrl} />
          {isPasswordResetAvailable() ? <Link className="signin-link" href="/auth/forgot">Forgot your password?</Link> : null}
          <p className="access-note"><LockKeyhole size={15} /> Accounts are managed by your instance administrator.</p>
        </div>
        <p className="privacy-note">Self-hosted. Private by design. Yours to keep.</p>
      </section>
    </main>
  );
}
