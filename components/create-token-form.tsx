"use client";

import { useActionState } from "react";

import { createApiToken } from "@/lib/actions";

export function CreateTokenForm() {
  const [state, action, pending] = useActionState(createApiToken, {});
  return (
    <div className="token-creator">
      <form action={action}>
        <input name="name" required placeholder="Mobile reader" aria-label="Token name" />
        <button className="primary-button" disabled={pending}>{pending ? "Creating…" : "Create token"}</button>
      </form>
      {state.error ? <p className="form-error">{state.error}</p> : null}
      {state.token ? <div className="token-secret"><strong>Copy this token now. It will not be shown again.</strong><code>{state.token}</code></div> : null}
    </div>
  );
}
