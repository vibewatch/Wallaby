"use client";

import { useActionState } from "react";

import { cancelTwoFactorAuthentication, completeTwoFactorAuthentication } from "@/lib/actions";
import type { TwoFactorMethod } from "@/lib/two-factor";

export function TwoFactorChallengeForm({ method }: { method: Exclude<TwoFactorMethod, "NONE"> }) {
  const [state, action, pending] = useActionState(completeTwoFactorAuthentication, {});
  return (
    <form action={action} className="signin-form two-factor-challenge-form">
      <label>
        <span>{method === "EMAIL" ? "Email code" : "Authenticator or recovery code"}</span>
        <input name="code" type="text" inputMode={method === "EMAIL" ? "numeric" : "text"} autoComplete="one-time-code" required autoFocus maxLength={64} />
      </label>
      <label className="trusted-device-option"><input name="trusted" type="checkbox" value="1" /><span>Trust this device for 15 days</span></label>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      <button className="primary-button full-button" disabled={pending}>{pending ? "Checking code…" : "Complete sign in"}</button>
      <button className="signin-cancel" formAction={cancelTwoFactorAuthentication} formNoValidate>Cancel and start again</button>
    </form>
  );
}
