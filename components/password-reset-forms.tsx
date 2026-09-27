"use client";

import Link from "next/link";
import { useActionState } from "react";

import { type PasswordResetState, requestPasswordResetLink } from "@/lib/actions";

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordResetLink, {});
  if (state.sent) {
    return (
      <div className="signin-form" role="status">
        <p className="form-success">If that account has an email address, a reset link is on its way. It works once, for 30 minutes.</p>
        <Link className="signin-link" href="/auth/signin">Back to sign in</Link>
      </div>
    );
  }
  return (
    <form action={action} className="signin-form">
      <label>
        <span>Username or email</span>
        <input name="identifier" type="text" autoComplete="username" required autoFocus maxLength={320} />
      </label>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      <button className="primary-button full-button" disabled={pending}>{pending ? "Sending…" : "Email me a reset link"}</button>
      <Link className="signin-link" href="/auth/signin">Back to sign in</Link>
    </form>
  );
}

export function ResetPasswordForm({ action: resetAction }: { action: (state: PasswordResetState, formData: FormData) => Promise<PasswordResetState> }) {
  const [state, action, pending] = useActionState(resetAction, {});
  return (
    <form action={action} className="signin-form">
      <label>
        <span>New password</span>
        <input name="newPassword" type="password" autoComplete="new-password" required autoFocus minLength={8} maxLength={200} />
      </label>
      <label>
        <span>Confirm new password</span>
        <input name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={200} />
      </label>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      <button className="primary-button full-button" disabled={pending}>{pending ? "Saving…" : "Set new password"}</button>
    </form>
  );
}
