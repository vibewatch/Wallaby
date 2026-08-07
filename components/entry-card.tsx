import type { Entry, Tag } from "@prisma/client";
import { Archive, Clock3, ExternalLink, Globe2, Star } from "lucide-react";
import Link from "next/link";

import { ActionForm } from "@/components/action-form";
import { toggleArchived, toggleStarred } from "@/lib/actions";
import { clampProgress, isFinished, isStarted, progressLabel } from "@/lib/reading-progress";
import { searchSnippet, type SearchTokens } from "@/lib/search";

export function EntryCard({ entry, selectionFormId, highlight = null, compact = false, displayThumbnail = true, readingSpeed = 200 }: {
  entry: Entry & { tags: Tag[] };
  selectionFormId?: string;
  /** Search terms to preview in context instead of the stored summary. */
  highlight?: SearchTokens | null;
  compact?: boolean;
  displayThumbnail?: boolean;
  readingSpeed?: number;
}) {
  const archiveAction = toggleArchived.bind(null, entry.id);
  const starAction = toggleStarred.bind(null, entry.id);
  const progress = clampProgress(entry.readingProgress);
  const progressText = progressLabel(progress);
  const snippet = highlight ? searchSnippet(entry.content, highlight) : null;
  return (
    <article className={`entry-card${compact ? " compact" : ""}${displayThumbnail ? "" : " no-thumbnail"}`} data-entry-card={entry.id}>
      {selectionFormId ? <input className="entry-select" type="checkbox" name="ids" value={entry.id} form={selectionFormId} aria-label={`Select ${entry.title}`} /> : null}
      {displayThumbnail ? <Link href={`/entries/${entry.id}`} className="entry-cover" aria-label={`Read ${entry.title}`}>
        {entry.previewPicture ? <span style={{ backgroundImage: `url(${JSON.stringify(entry.previewPicture).slice(1, -1)})` }} /> : <span className="cover-placeholder">{entry.domainName?.slice(0, 1).toUpperCase() ?? "W"}</span>}
      </Link> : null}
      <div className="entry-card-body">
        <div className="entry-meta">
          <span>{entry.domainName ?? "Saved article"}</span>
          <span>·</span>
          <span>{relativeDate(entry.createdAt)}</span>
        </div>
        <Link href={`/entries/${entry.id}`} className="entry-title" data-shortcut="open"><h2>{entry.title}</h2></Link>
        {snippet ? (
          <p className="entry-summary">{snippet.map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</p>
        ) : entry.summary ? <p className="entry-summary">{entry.summary}</p> : null}
        {isStarted(progress) ? (
          <div className="entry-progress" title={progressText ?? undefined}>
            <span style={{ transform: `scaleX(${progress})` }} />
          </div>
        ) : null}
        <div className="entry-card-footer">
          <div className="entry-facts">
            <span><Clock3 size={14} /> {adjustedReadingTime(entry.readingTime, readingSpeed)} min</span>
            {progressText ? <span className={isFinished(progress) ? "entry-progress-text finished" : "entry-progress-text"}>{progressText}</span> : null}
            {entry.language ? <span>{entry.language.split(/[-_]/)[0].toUpperCase()}</span> : null}
            {entry.tags.slice(0, 3).map((tag) => <Link key={tag.id} href={`/entries?tag=${tag.slug}`}>#{tag.label}</Link>)}
          </div>
          <div className="card-actions">
            <ActionForm action={starAction}><button data-shortcut="star" className={entry.starred ? "active" : ""} aria-label={entry.starred ? "Remove star" : "Star entry"}><Star size={17} fill={entry.starred ? "currentColor" : "none"} /></button></ActionForm>
            <ActionForm action={archiveAction}><button data-shortcut="archive" className={entry.archived ? "active" : ""} aria-label={entry.archived ? "Mark unread" : "Archive entry"}><Archive size={17} /></button></ActionForm>
            <a href={entry.url} target="_blank" rel="noopener noreferrer" aria-label="Open original" data-shortcut="original"><ExternalLink size={17} /></a>
            <Link href={`/entries?view=same-domain&entry=${entry.id}`} aria-label={`More from ${entry.domainName ?? "this domain"}`}><Globe2 size={17} /></Link>
          </div>
        </div>
      </div>
    </article>
  );
}

function relativeDate(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(date);
}

function adjustedReadingTime(readingTime: number, readingSpeed: number): number {
  return Math.max(1, Math.ceil(readingTime * 200 / readingSpeed));
}
