import { Braces, KeyRound, Trash2 } from "lucide-react";
import type { Metadata } from "next";

import { CreateOAuthClientForm } from "@/components/create-oauth-client-form";
import { revokeDeveloperClient } from "@/lib/actions";
import { requireUser } from "@/lib/auth-user";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Developer clients" };

export default async function DeveloperPage() {
  const user = await requireUser();
  const clients = await db.oAuthClient.findMany({
    where: { userId: user.id },
    include: { _count: { select: { accessTokens: true, refreshTokens: true } } },
    orderBy: { createdAt: "desc" },
  });
  return (
    <div className="settings-page developer-page">
      <header className="settings-header"><p className="eyebrow">Build on your library</p><h1>OAuth applications</h1><p>Create revocable clients for wallabag-compatible API integrations.</p></header>
      <section className="settings-section">
        <div className="settings-label"><Braces size={18} /><div><h2>New client</h2><p>Authorization-code clients should use PKCE. Password grants cannot bypass account two-factor authentication.</p></div></div>
        <CreateOAuthClientForm />
      </section>
      <section className="settings-section">
        <div className="settings-label"><KeyRound size={18} /><div><h2>Registered clients</h2><p>Deleting a client immediately revokes its codes, access tokens, and refresh tokens.</p></div></div>
        <div className="oauth-client-list">
          {clients.map((client) => {
            const redirectUris = jsonStrings(client.redirectUris);
            const grants = jsonStrings(client.allowedGrantTypes);
            return <article key={client.id}>
              <div><strong>{client.name}</strong><code>{client.publicId}</code><small>Created {client.createdAt.toLocaleDateString()} · {client._count.accessTokens} access · {client._count.refreshTokens} refresh</small></div>
              <p><span>Redirects</span>{redirectUris.join(" · ")}</p>
              <p><span>Grants</span>{grants.join(", ")}</p>
              <form action={revokeDeveloperClient.bind(null, client.id)}><button className="text-danger" aria-label={`Delete OAuth client ${client.name}`}><Trash2 size={14} /> Delete</button></form>
            </article>;
          })}
          {!clients.length ? <p className="muted">No OAuth clients yet.</p> : null}
        </div>
      </section>
      <section className="portability-card oauth-endpoints">
        <h2>Endpoints</h2>
        <code>GET /oauth/v2/auth</code>
        <code>POST /oauth/v2/token</code>
        <p>Supported grants: authorization_code with optional S256 PKCE, rotating refresh_token, password for non-2FA accounts, and implicit token for legacy clients.</p>
      </section>
    </div>
  );
}

function jsonStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
