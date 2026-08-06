import type { Entry, Tag } from "@prisma/client";
import { Archive, Clock3, ExternalLink, Globe2, Star } from "lucide-react";
import Link from "next/link";

import { toggleArchived, toggleStarred } from "@/lib/actions";

export function EntryCard({ entry, selectionFormId, compact = false, displayThumbnail = true, readingSpeed = 200 }: {
  entry: Entry & { tags: Tag[] };
  selectionFormId?: string;
  compact?: boolean;
  displayThumbnail?: boolean;
  readingSpeed?: number;
}) {
  const archiveAction = toggleArchived.bind(null, entry.id);
  const starAction = toggleStarred.bind(null, entry.id);
  return (
    <article className={`entry-card${compact ? " compact" : ""}${displayThumbnail ? "" : " no-thumbnail"}`}>
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
        <Link href={`/entries/${entry.id}`} className="entry-title"><h2>{entry.title}</h2></Link>
        {entry.summary ? <p className="entry-summary">{entry.summary}</p> : null}
        <div className="entry-card-footer">
          <div className="entry-facts">
            <span><Clock3 size={14} /> {adjustedReadingTime(entry.readingTime, readingSpeed)} min</span>
            {entry.language ? <span>{entry.language.split(/[-_]/)[0].toUpperCase()}</span> : null}
            {entry.tags.slice(0, 3).map((tag) => <Link key={tag.id} href={`/entries?tag=${tag.slug}`}>#{tag.label}</Link>)}
          </div>
          <div className="card-actions">
            <form action={starAction}><button className={entry.starred ? "active" : ""} aria-label={entry.starred ? "Remove star" : "Star entry"}><Star size={17} fill={entry.starred ? "currentColor" : "none"} /></button></form>
            <form action={archiveAction}><button className={entry.archived ? "active" : ""} aria-label={entry.archived ? "Mark unread" : "Archive entry"}><Archive size={17} /></button></form>
            <a href={entry.url} target="_blank" rel="noopener noreferrer" aria-label="Open original"><ExternalLink size={17} /></a>
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
