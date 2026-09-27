import { BookOpenText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ResetPasswordForm } from "@/components/password-reset-forms";
import { completePasswordReset } from "@/lib/actions";
import { isPasswordResetTokenValid } from "@/lib/password-reset";

// The token is in the path; never pass it on to another site.
export const metadata: Metadata = { title: "Choose a new password", referrer: "no-referrer" };

export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = await isPasswordResetTokenValid(token);
  return (
    <main className="signin-page">
      <section className="signin-story" aria-label="About Wallaby">
        <div className="brand-mark light-mark"><BookOpenText size={22} strokeWidth={1.8} /></div>
        <p className="eyebrow light-eyebrow">Almost there</p>
        <h1>A fresh<br />start.</h1>
        <p className="signin-intro">Choose a new password. Every device signed in to your account will be signed out.</p>
      </section>
      <section className="signin-panel">
        <div className="signin-box">
          <p className="eyebrow">Password reset</p>
          {valid ? (
            <>
              <h2>Choose a new password</h2>
              <p className="muted">Use at least 8 characters. Two-factor authentication stays on.</p>
              <ResetPasswordForm action={completePasswordReset.bind(null, token)} />
            </>
          ) : (
            <>
              <h2>This link has expired</h2>
              <p className="muted">Reset links work once and only for 30 minutes.</p>
              <Link className="primary-button full-button" href="/auth/forgot">Request a new link</Link>
            </>
          )}
        </div>
        <p className="privacy-note">Single-use link · Signs out every device · No tracking</p>
      </section>
    </main>
  );
}
