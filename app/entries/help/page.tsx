import { BookOpenCheck, Braces, Download, Highlighter, Keyboard, Search, Shield, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { BookmarkletLink } from "@/components/bookmarklet-link";
import { requireUser } from "@/lib/auth-user";
import { shortcutGroups } from "@/lib/shortcuts";

export const metadata: Metadata = { title: "Help & quick start" };

export default async function HelpPage() {
  const user = await requireUser();
  return (
    <div className="settings-page help-page">
      <header className="settings-header"><p className="eyebrow">A calm place to begin</p><h1>Help & quick start</h1><p>Save a page, make it yours, and keep a portable copy.</p></header>
      <section className="help-steps" aria-label="Quick start">
        <article><span>1</span><div><h2>Save</h2><p>Paste an address into the bar above your library, or share a page to Wallaby from your phone once it is installed as an app. Wallaby follows safe public redirects and extracts a readable copy.</p><Link href="/entries/new">Save an article</Link></div></article>
        <article><span>2</span><div><h2>Read</h2><p>Open an entry to adjust typography, archive or star it, edit its title, add tags, and select text for a persistent highlight.</p></div></article>
        <article><span>3</span><div><h2>Return</h2><p>Use search, advanced filters, tags, private feeds, or a random entry to return to what matters.</p></div></article>
      </section>
      <section className="help-bookmarklet" aria-labelledby="bookmarklet-heading">
        <div>
          <h2 id="bookmarklet-heading">Save from any page</h2>
          <p>Drag this button to your browser&apos;s bookmarks bar. On an article, click the bookmark to open Wallaby with the address and title filled in, then choose Save.</p>
        </div>
        <BookmarkletLink />
      </section>
      <section className="help-grid">
        <article><Search size={19} /><h2>Find and organize</h2><p>Search ranks title, text, domain, and tag matches by relevance. Every word must appear, a trailing word matches by prefix, and <kbd>&quot;quoted text&quot;</kbd> matches an exact phrase. Filters cover dates, reading time, language, extraction status, previews, notes, and sharing.</p></article>
        <article><Highlighter size={19} /><h2>Notes and highlights</h2><p>Select article text for a highlight or add a quote and note manually. Stored selectors recover by quoted text if content changes.</p></article>
        <article><Sparkles size={19} /><h2>Automatic tags</h2><p>Rules in Settings can label new and existing entries by title, URL, status, content, language, reading time, or domain. The sidebar shows your most-used tags; All tags lists every one, A to Z or by use.</p></article>
        <article><Download size={19} /><h2>Bring it in, take it out</h2><p>Import common read-later and bookmark exports. Download filtered results as JSON, CSV, XML, text, Markdown, EPUB, or PDF.</p><Link href="/entries/import">Import & export</Link></article>
        <article><Braces size={19} /><h2>Browser companion</h2><p>Save from Chrome or Firefox, organize tags, and optionally capture an article you are signed in to read. Connect your own instance with a dedicated API token from Settings.</p><a href="https://github.com/vibewatch/Wallaby/tree/main/extensions" target="_blank" rel="noreferrer">Install the extension</a></article>
        <article><Braces size={19} /><h2>Feeds and API</h2><p>Create revocable private feed and bearer tokens in Settings. API responses follow wallabag field names where practical.</p><Link href="/entries/settings">Open settings</Link></article>
        <article><Shield size={19} /><h2>Account security</h2><p>Enable authenticator-app or email two-factor authentication in Settings. Save the one-time recovery codes and revoke trusted devices you no longer use.</p><Link href="/entries/settings">Open security settings</Link></article>
        <article><Keyboard size={19} /><h2>Keyboard shortcuts</h2><p>Press <kbd>?</kbd> anywhere for the full list. <kbd>j</kbd> and <kbd>k</kbd> move through entries, <kbd>/</kbd> jumps to search, and <kbd>g</kbd> then a letter switches views.</p></article>
        {user.role === "ADMIN" ? <article><Shield size={19} /><h2>Administration</h2><p>Create accounts, manage roles and passwords, inspect library counts, and maintain instance redirect-origin rules.</p><Link href="/entries/admin">Open administration</Link></article> : null}
      </section>
      <section className="help-shortcuts" aria-label="Keyboard shortcuts">
        <h2><Keyboard size={18} /> Every shortcut</h2>
        <div className="shortcut-help-grid">
          {shortcutGroups.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.hints.map((hint) => (
                  <div key={hint.keys}>
                    <dt>{hint.keys.split(" ").map((part, index) => part === "then" || part === "or"
                      ? <span key={index}> {part} </span>
                      : <kbd key={index}>{part}</kbd>)}</dt>
                    <dd>{hint.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </section>
      <section className="help-note"><BookOpenCheck size={20} /><div><h2>Privacy and extraction</h2><p>Saved HTML is sanitized before display. Network extraction blocks local and reserved addresses, limits redirects, response size, and request time, and encrypts optional site credentials at rest.</p></div></section>
    </div>
  );
}
