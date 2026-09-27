"use client";

import { useActionState } from "react";

import { authenticate } from "@/lib/actions";

export function SignInForm({ callbackUrl }: { callbackUrl?: string }) {
  const [state, action, pending] = useActionState(authenticate, {});

  return (
    <form action={action} className="signin-form">
      {callbackUrl ? <input type="hidden" name="callbackUrl" value={callbackUrl} /> : null}
      <label>
        <span>Username or email</span>
        <input name="username" type="text" autoComplete="username" required autoFocus placeholder="demo" defaultValue={state.username} />
      </label>
      <label>
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required placeholder="••••••••••" />
      </label>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      <button className="primary-button full-button" disabled={pending}>
        {pending ? "Opening your library…" : "Sign in"}
      </button>
    </form>
  );
}
