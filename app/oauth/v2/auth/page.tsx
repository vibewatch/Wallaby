import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { authorizeDeveloperClient } from "@/lib/actions";
import { getOAuthAuthorizationContext, type OAuthAuthorizationInput } from "@/lib/oauth";

export const metadata: Metadata = { title: "Authorize application" };

type Query = Record<string, string | string[] | undefined>;

export default async function OAuthAuthorizationPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const input = parseAuthorizationInput(query);
  let context: Awaited<ReturnType<typeof getOAuthAuthorizationContext>>;
  try { context = await getOAuthAuthorizationContext(input); }
  catch (error) {
    return <main className="oauth-consent-page"><section className="oauth-consent"><ShieldCheck size={28} /><h1>Authorization request rejected</h1><p>{error instanceof Error ? error.message : "The OAuth request is invalid."}</p></section></main>;
  }
  const session = await auth();
  if (!session?.user?.id) {
    const callback = `/oauth/v2/auth?${serializeQuery(query)}`;
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(callback)}`);
  }
  return (
    <main className="oauth-consent-page">
      <section className="oauth-consent">
        <ShieldCheck size={28} />
        <p className="eyebrow">Authorization request</p>
        <h1>Allow {context.client.name}?</h1>
        <p>This application will be able to use the Wallaby API as <strong>{session.user.name ?? session.user.email ?? "your account"}</strong>. You can revoke the client later from Developer clients.</p>
        {context.scope ? <p className="oauth-scope"><span>Requested scope</span><code>{context.scope}</code></p> : null}
        <p className="oauth-redirect"><span>After authorization</span><code>{context.redirectUri}</code></p>
        <form action={authorizeDeveloperClient}>
          <input type="hidden" name="client_id" value={context.client.publicId} />
          <input type="hidden" name="redirect_uri" value={context.redirectUri} />
          <input type="hidden" name="response_type" value={context.responseType} />
          {context.state ? <input type="hidden" name="state" value={context.state} /> : null}
          {context.scope ? <input type="hidden" name="scope" value={context.scope} /> : null}
          {context.codeChallenge ? <input type="hidden" name="code_challenge" value={context.codeChallenge} /> : null}
          {context.codeChallengeMethod ? <input type="hidden" name="code_challenge_method" value={context.codeChallengeMethod} /> : null}
          <button className="secondary-button" name="decision" value="deny">Deny</button>
          <button className="primary-button" name="decision" value="approve">Authorize application</button>
        </form>
      </section>
    </main>
  );
}

function parseAuthorizationInput(query: Query): OAuthAuthorizationInput {
  const responseType = first(query.response_type);
  if (responseType !== "code" && responseType !== "token") throw new Error("response_type must be code or token");
  const method = first(query.code_challenge_method);
  if (method && method !== "S256" && method !== "plain") throw new Error("code_challenge_method must be S256 or plain");
  return {
    clientId: required(query.client_id, "client_id"),
    redirectUri: required(query.redirect_uri, "redirect_uri"),
    responseType,
    state: first(query.state),
    scope: first(query.scope),
    codeChallenge: first(query.code_challenge),
    codeChallengeMethod: method === "S256" || method === "plain" ? method : undefined,
  };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function required(value: string | string[] | undefined, name: string): string {
  const resolved = first(value)?.trim();
  if (!resolved) throw new Error(`${name} is required`);
  return resolved;
}

function serializeQuery(query: Query): string {
  const output = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) output.append(key, item);
    else if (value !== undefined) output.set(key, value);
  }
  return output.toString();
}
