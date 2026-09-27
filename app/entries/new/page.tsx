import { BookmarkPlus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { SaveEntryForm } from "@/components/save-entry-form";
import { requireUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { hashUrl, tagSuggestions } from "@/lib/entries";
import { InvalidEntryUrlError, parseEntryUrl } from "@/lib/entry-url";
import { readSharedArticle } from "@/lib/share-target";

export const metadata: Metadata = { title: "Save an article" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Landing page for the bookmarklet and the installed app's share target. It
 * only ever pre-fills the save form: the save itself is a same-origin server
 * action, so another site linking here cannot add entries to a library.
 */
export default async function NewEntryPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const shared = readSharedArticle(await searchParams);
  const [existing, tagLabels] = await Promise.all([
    shared.url ? findSavedEntry(user.id, shared.url) : null,
    tagSuggestions(user.id),
  ]);

  return (
    <div className="settings-page save-entry-page">
      <header className="settings-header">
        <p className="eyebrow">Save for later</p>
        <h1>{shared.title || "Save an article"}</h1>
        <p>{shared.url ? "Check the address, add tags if you like, and Wallaby will fetch a readable copy." : "Paste the address of an article to fetch a readable copy."}</p>
      </header>
      {existing ? (
        <p className="saved-notice" role="status">
          <BookmarkPlus size={14} /> Already in your library as <Link href={`/entries/${existing.id}`}>{existing.title}</Link>. Saving again adds any new tags.
        </p>
      ) : null}
      <SaveEntryForm className="save-entry-form" defaultUrl={shared.url} defaultTags={shared.tags} tagSuggestions={tagLabels} fallbackTitle={shared.title} autoFocus={!shared.url} />
    </div>
  );
}

async function findSavedEntry(userId: string, value: string) {
  let url: URL;
  try { url = parseEntryUrl(value); }
  catch (error) {
    if (error instanceof InvalidEntryUrlError) return null;
    throw error;
  }
  return db.entry.findUnique({ where: { userId_urlHash: { userId, urlHash: hashUrl(url.toString()) } }, select: { id: true, title: true } });
}
