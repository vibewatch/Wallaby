"use client";

import { useActionState } from "react";

import { createDeveloperClient } from "@/lib/actions";

export function CreateOAuthClientForm() {
  const [state, action, pending] = useActionState(createDeveloperClient, {});
  return (
    <div className="oauth-client-creator">
      <form action={action} className="settings-form">
        <label><span>Application name</span><input name="name" required maxLength={100} placeholder="Mobile reader" /></label>
        <label className="oauth-redirect-field"><span>Exact redirect URLs, one per line</span><textarea name="redirectUris" required rows={3} placeholder="https://reader.example/oauth/callback" /></label>
        <fieldset>
          <legend>Allowed grants</legend>
          <label><input name="grantTypes" type="checkbox" value="authorization_code" defaultChecked /> Authorization code</label>
          <label><input name="grantTypes" type="checkbox" value="refresh_token" defaultChecked /> Refresh token</label>
          <label><input name="grantTypes" type="checkbox" value="password" /> Password</label>
          <label><input name="grantTypes" type="checkbox" value="token" /> Implicit token</label>
        </fieldset>
        <button className="primary-button" disabled={pending}>{pending ? "Creating…" : "Create OAuth client"}</button>
      </form>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      {state.clientId && state.clientSecret ? <div className="token-secret oauth-client-secret">
        <strong>Copy the client secret now. Only its hash is stored.</strong>
        <span>Client ID</span><code>{state.clientId}</code>
        <span>Client secret</span><code>{state.clientSecret}</code>
      </div> : null}
    </div>
  );
}
