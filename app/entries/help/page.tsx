import { BookOpenCheck, Braces, Download, Highlighter, Search, Shield, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth-user";

export const metadata: Metadata = { title: "Help & quick start" };

export default async function HelpPage() {
  const user = await requireUser();
  return (
    <div className="settings-page help-page">
      <header className="settings-header"><p className="eyebrow">A calm place to begin</p><h1>Help & quick start</h1><p>Save a page, make it yours, and keep a portable copy.</p></header>
      <section className="help-steps" aria-label="Quick start">
        <article><span>1</span><div><h2>Save</h2><p>Paste an HTTP or HTTPS address into the bar above your library. Wallaby follows safe public redirects and extracts a readable copy.</p><Link href="/entries?view=unread">Open unread entries</Link></div></article>
        <article><span>2</span><div><h2>Read</h2><p>Open an entry to adjust typography, archive or star it, edit its title, add tags, and select text for a persistent highlight.</p></div></article>
        <article><span>3</span><div><h2>Return</h2><p>Use search, advanced filters, tags, private feeds, or a random entry to return to what matters.</p></div></article>
      </section>
      <section className="help-grid">
        <article><Search size={19} /><h2>Find and organize</h2><p>Search title, text, domain, and tags. Filters cover dates, reading time, language, extraction status, previews, notes, and sharing.</p></article>
        <article><Highlighter size={19} /><h2>Notes and highlights</h2><p>Select article text for a highlight or add a quote and note manually. Stored selectors recover by quoted text if content changes.</p></article>
        <article><Sparkles size={19} /><h2>Automatic tags</h2><p>Rules in Settings can label new and existing entries by title, URL, status, content, language, reading time, or domain.</p></article>
        <article><Download size={19} /><h2>Bring it in, take it out</h2><p>Import common read-later and bookmark exports. Download filtered results as JSON, CSV, XML, text, Markdown, EPUB, or PDF.</p><Link href="/entries/import">Import & export</Link></article>
        <article><Braces size={19} /><h2>Feeds and API</h2><p>Create revocable private feed and bearer tokens in Settings. API responses follow wallabag field names where practical.</p><Link href="/entries/settings">Open settings</Link></article>
        <article><Shield size={19} /><h2>Account security</h2><p>Enable authenticator-app or email two-factor authentication in Settings. Save the one-time recovery codes and revoke trusted devices you no longer use.</p><Link href="/entries/settings">Open security settings</Link></article>
        {user.role === "ADMIN" ? <article><Shield size={19} /><h2>Administration</h2><p>Create accounts, manage roles and passwords, inspect library counts, and maintain instance redirect-origin rules.</p><Link href="/entries/admin">Open administration</Link></article> : null}
      </section>
      <section className="help-note"><BookOpenCheck size={20} /><div><h2>Privacy and extraction</h2><p>Saved HTML is sanitized before display. Network extraction blocks local and reserved addresses, limits redirects, response size, and request time, and encrypts optional site credentials at rest.</p></div></section>
    </div>
  );
}
