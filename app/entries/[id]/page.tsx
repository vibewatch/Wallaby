import { Archive, ArrowLeft, ArrowRight, ExternalLink, Highlighter, RefreshCw, Share2, Star, Trash2, X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";

import { ArticleAnnotator } from "@/components/article-annotator";
import { ActionForm } from "@/components/action-form";
import { ConfirmForm } from "@/components/confirm-form";
import { ReadingProgress } from "@/components/reading-progress";
import { TagInput } from "@/components/tag-input";
import {
  addAnnotation,
  addTag,
  deleteAnnotation,
  deleteEntry,
  refetchEntry,
  removeTag,
  toggleArchivedInReader,
  toggleShare,
  toggleStarred,
  updateAnnotation,
  updateEntryTitle,
} from "@/lib/actions";
import { requireUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { tagSuggestions } from "@/lib/entries";
import { entryHref, findListNeighbours, libraryHref, readListParam } from "@/lib/entry-list";

type PageProps = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const user = await requireUser();
  const { id } = await params;
  // Scoped to the owner: the document title must not reveal another reader's entry.
  const entry = await db.entry.findFirst({ where: { id, userId: user.id }, select: { title: true } });
  return { title: entry?.title ?? "Entry" };
}

export default async function EntryPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const alreadySaved = query.saved === "existing";
  // Present only when the entry was opened from a library list.
  const list = readListParam(query.list);
  const [entry, preference, tagLabels] = await Promise.all([
    db.entry.findFirst({
      where: { id, userId: user.id },
      include: { tags: true, annotations: { orderBy: { createdAt: "desc" } } },
    }),
    db.userPreference.findUnique({ where: { userId: user.id } }),
    tagSuggestions(user.id),
  ]);
  if (!entry) notFound();
  const neighbours = list ? await findListNeighbours(user.id, list, entry, preference?.readingSpeed ?? 200) : null;

  const authors = Array.isArray(entry.publishedBy) ? entry.publishedBy.filter((value): value is string => typeof value === "string") : [];
  const readerStyle = {
    "--reader-width": `${preference?.maxWidth ?? 760}px`,
    "--reader-font": preference?.font === "serif" ? "var(--serif)" : "var(--sans)",
    "--reader-size": `${preference?.fontSize ?? 1}rem`,
    "--reader-line-height": preference?.lineHeight ?? 1.75,
  } as CSSProperties;
  const readingTime = Math.max(1, Math.ceil(entry.readingTime * 200 / (preference?.readingSpeed ?? 200)));
  return (
    <div className="reader-page">
      <ReadingProgress key={entry.id} entryId={entry.id} initialProgress={entry.readingProgress} archiveOnFinish={preference?.actionMarkAsRead ?? false} />
      <header className="reader-toolbar">
        <Link href={libraryHref(list)} className="back-link" data-shortcut="back"><ArrowLeft size={17} /> Library</Link>
        <div className="reader-actions">
          <ActionForm action={toggleStarred.bind(null, entry.id)}><button data-shortcut="star" className={entry.starred ? "active" : ""} title="Star"><Star size={17} fill={entry.starred ? "currentColor" : "none"} /></button></ActionForm>
          <ActionForm action={toggleArchivedInReader.bind(null, entry.id)}><input type="hidden" name="list" value={list} /><button data-shortcut="archive" className={entry.archived ? "active" : ""} title={entry.archived ? "Mark unread" : "Archive"}><Archive size={17} /></button></ActionForm>
          <ActionForm action={refetchEntry.bind(null, entry.id)}><button data-shortcut="refetch" title="Fetch article again"><RefreshCw size={17} /></button></ActionForm>
          <form action={toggleShare.bind(null, entry.id)}><button className={entry.shareToken ? "active" : ""} title="Public sharing"><Share2 size={17} /></button></form>
          <a href={entry.url} target="_blank" rel="noopener noreferrer" title="Open original" data-shortcut="original"><ExternalLink size={17} /></a>
          <ConfirmForm action={deleteEntry.bind(null, entry.id)} confirm={`Delete “${entry.title}”? This removes the saved copy and cannot be undone.`}>
            <input type="hidden" name="list" value={list} />
            <button className="danger-action" title="Delete"><Trash2 size={17} /></button>
          </ConfirmForm>
        </div>
      </header>

      <div className="reader-columns">
        <article className="reader-article" style={readerStyle} data-reading-target>
          {preference?.customCss ? <style>{`.reader-article > .article-content { ${preference.customCss} }`}</style> : null}
          <header className="article-header">
            <p className="article-domain"><Link href={`/entries?view=same-domain&entry=${entry.id}`}>{entry.domainName}</Link></p>
            <div className="article-title-row"><h1>{entry.title}</h1><details><summary>Edit title</summary><form action={updateEntryTitle.bind(null, entry.id)}><input name="title" defaultValue={entry.title} required aria-label="Entry title" /><button>Save</button></form></details></div>
            <div className="article-byline">
              {authors.length ? <span>By {authors.join(", ")}</span> : null}
              {entry.publishedAt ? <span>{entry.publishedAt.toLocaleDateString("en", { dateStyle: "long" })}</span> : null}
              <span>{readingTime} min read</span>
            </div>
            <div className="reader-tags">
              {entry.tags.map((tag) => (
                <span key={tag.id}>#{tag.label}<form action={removeTag.bind(null, entry.id, tag.id)}><button aria-label={`Remove ${tag.label}`}><X size={12} /></button></form></span>
              ))}
              <details><summary>+ tag</summary><form action={addTag.bind(null, entry.id)}><TagInput name="tags" placeholder="design, research" label="Add tags" suggestions={tagLabels.filter((label) => !entry.tags.some((tag) => tag.label === label))} required /><button>Add</button></form></details>
            </div>
            {entry.shareToken ? <p className="share-notice"><Share2 size={14} /> Public link: <Link href={`/share/${entry.shareToken}`}>/share/{entry.shareToken.slice(0, 9)}…</Link></p> : null}
            {alreadySaved ? <p className="saved-notice" role="status">This article was already in your library — saved {entry.createdAt.toLocaleDateString("en", { dateStyle: "long" })}.</p> : null}
            {entry.isNotParsed ? <p className="extraction-warning">Wallaby could not isolate the full article. You can refetch it or open the original page.</p> : null}
          </header>
          {entry.previewPicture ? <div className="reader-hero" style={{ backgroundImage: `url(${JSON.stringify(entry.previewPicture).slice(1, -1)})` }} /> : null}
          <ArticleAnnotator
            entryId={entry.id}
            html={entry.content}
            annotations={entry.annotations.map((annotation) => ({
              id: annotation.id,
              quote: annotation.quote,
              ranges: Array.isArray(annotation.ranges) ? annotation.ranges.filter(isRangeSelector) : [],
            }))}
          />
          {neighbours?.previous || neighbours?.next ? (
            <nav className="reader-pager" aria-label="More in this list">
              {neighbours.previous ? <Link href={entryHref(neighbours.previous.id, list)} rel="prev" data-shortcut="previous-entry"><ArrowLeft size={16} /><span><small>Previous</small>{neighbours.previous.title}</span></Link> : <span />}
              {neighbours.next ? <Link href={entryHref(neighbours.next.id, list)} rel="next" data-shortcut="next-entry" className="next"><span><small>Next</small>{neighbours.next.title}</span><ArrowRight size={16} /></Link> : null}
            </nav>
          ) : null}
        </article>

        <aside className="annotations-panel">
          <div className="annotations-heading"><Highlighter size={17} /><span>Notes</span><small>{entry.annotations.length}</small></div>
          <form action={addAnnotation.bind(null, entry.id)} className="annotation-form">
            <textarea name="quote" placeholder="Optional quote from the article" rows={2} />
            <textarea name="text" placeholder="Capture a thought…" rows={4} required />
            <button className="primary-button">Add note</button>
          </form>
          <div className="annotation-list">
            {entry.annotations.map((annotation) => (
              <article key={annotation.id}>
                {annotation.quote ? <blockquote>{annotation.quote}</blockquote> : null}
                <p>{annotation.text}</p>
                {/* Keyed on the edit time so a saved edit closes and shows the new text. */}
                <details className="annotation-edit" key={annotation.updatedAt.toISOString()}>
                  <summary>Edit note</summary>
                  <form action={updateAnnotation.bind(null, entry.id, annotation.id)}>
                    <textarea name="text" defaultValue={annotation.text} rows={4} required maxLength={10_000} aria-label="Note text" />
                    <button className="secondary-button">Save note</button>
                  </form>
                </details>
                <footer><time>{annotation.createdAt.toLocaleDateString()}</time><form action={deleteAnnotation.bind(null, entry.id, annotation.id)}><button>Delete</button></form></footer>
              </article>
            ))}
            {!entry.annotations.length ? <p className="annotation-empty">Notes and highlights help ideas survive beyond the reading session.</p> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

function isRangeSelector(value: unknown): value is { start: string; startOffset: number; end: string; endOffset: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selector = value as Record<string, unknown>;
  return typeof selector.start === "string" && typeof selector.end === "string" && Number.isInteger(selector.startOffset) && Number.isInteger(selector.endOffset);
}
