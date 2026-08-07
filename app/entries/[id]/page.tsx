import { Archive, ArrowLeft, ExternalLink, Highlighter, RefreshCw, Share2, Star, Trash2, X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";

import { ArticleAnnotator } from "@/components/article-annotator";
import { ActionForm } from "@/components/action-form";
import { ConfirmForm } from "@/components/confirm-form";
import { ReadingProgress } from "@/components/reading-progress";
import {
  addAnnotation,
  addTag,
  deleteAnnotation,
  deleteEntry,
  refetchEntry,
  removeTag,
  toggleArchived,
  toggleShare,
  toggleStarred,
  updateEntryTitle,
} from "@/lib/actions";
import { requireUser } from "@/lib/auth-user";
import { db } from "@/lib/db";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const entry = await db.entry.findUnique({ where: { id }, select: { title: true } });
  return { title: entry?.title ?? "Entry" };
}

export default async function EntryPage({ params }: PageProps) {
  const user = await requireUser();
  const { id } = await params;
  const [entry, preference] = await Promise.all([
    db.entry.findFirst({
      where: { id, userId: user.id },
      include: { tags: true, annotations: { orderBy: { createdAt: "desc" } } },
    }),
    db.userPreference.findUnique({ where: { userId: user.id } }),
  ]);
  if (!entry) notFound();

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
      <ReadingProgress entryId={entry.id} initialProgress={entry.readingProgress} archiveOnFinish={preference?.actionMarkAsRead ?? false} />
      <header className="reader-toolbar">
        <Link href="/entries" className="back-link"><ArrowLeft size={17} /> Library</Link>
        <div className="reader-actions">
          <ActionForm action={toggleStarred.bind(null, entry.id)}><button data-shortcut="star" className={entry.starred ? "active" : ""} title="Star"><Star size={17} fill={entry.starred ? "currentColor" : "none"} /></button></ActionForm>
          <ActionForm action={toggleArchived.bind(null, entry.id)}><button data-shortcut="archive" className={entry.archived ? "active" : ""} title={entry.archived ? "Mark unread" : "Archive"}><Archive size={17} /></button></ActionForm>
          <form action={refetchEntry.bind(null, entry.id)}><button data-shortcut="refetch" title="Fetch article again"><RefreshCw size={17} /></button></form>
          <form action={toggleShare.bind(null, entry.id)}><button className={entry.shareToken ? "active" : ""} title="Public sharing"><Share2 size={17} /></button></form>
          <a href={entry.url} target="_blank" rel="noopener noreferrer" title="Open original" data-shortcut="original"><ExternalLink size={17} /></a>
          <ConfirmForm action={deleteEntry.bind(null, entry.id)} confirm={`Delete “${entry.title}”? This removes the saved copy and cannot be undone.`}>
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
              <details><summary>+ tag</summary><form action={addTag.bind(null, entry.id)}><input name="tags" placeholder="design, research" required /><button>Add</button></form></details>
            </div>
            {entry.shareToken ? <p className="share-notice"><Share2 size={14} /> Public link: <Link href={`/share/${entry.shareToken}`}>/share/{entry.shareToken.slice(0, 9)}…</Link></p> : null}
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
