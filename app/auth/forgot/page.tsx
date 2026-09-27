import { BookOpenText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ForgotPasswordForm } from "@/components/password-reset-forms";
import { isPasswordResetAvailable } from "@/lib/password-reset";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  const available = isPasswordResetAvailable();
  return (
    <main className="signin-page">
      <section className="signin-story" aria-label="About Wallaby">
        <div className="brand-mark light-mark"><BookOpenText size={22} strokeWidth={1.8} /></div>
        <p className="eyebrow light-eyebrow">It happens</p>
        <h1>Find your<br />way back.</h1>
        <p className="signin-intro">Your library is safe. Choose a new password and pick up where you left off.</p>
      </section>
      <section className="signin-panel">
        <div className="signin-box">
          <p className="eyebrow">Forgot your password</p>
          <h2>Reset your password</h2>
          {available ? (
            <>
              <p className="muted">Enter your username or email. We will send a single-use link to the address on your account.</p>
              <ForgotPasswordForm />
            </>
          ) : (
            <>
              <p className="muted">This instance cannot send email, so passwords can only be reset by its administrator.</p>
              <Link className="signin-link" href="/auth/signin">Back to sign in</Link>
            </>
          )}
        </div>
        <p className="privacy-note">Single-use link · Expires in 30 minutes · No tracking</p>
      </section>
    </main>
  );
}
