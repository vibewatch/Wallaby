import { BookOpenText, ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { db } from "@/lib/db";

type PageProps = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  const entry = await db.entry.findUnique({ where: { shareToken: token }, select: { title: true, summary: true } });
  return { title: entry?.title ?? "Shared entry", description: entry?.summary ?? undefined };
}

export default async function SharedEntryPage({ params }: PageProps) {
  const { token } = await params;
  const entry = await db.entry.findUnique({ where: { shareToken: token } });
  if (!entry) notFound();
  const authors = Array.isArray(entry.publishedBy) ? entry.publishedBy.filter((value): value is string => typeof value === "string") : [];

  return (
    <main className="shared-page">
      <nav className="shared-nav"><Link href="/"><span className="brand-mark"><BookOpenText size={18} /></span> wallaby</Link><span>A shared reading copy</span></nav>
      <article className="shared-article">
        <header className="article-header">
          <p className="article-domain">{entry.domainName}</p>
          <h1>{entry.title}</h1>
          <div className="article-byline">
            {authors.length ? <span>By {authors.join(", ")}</span> : null}
            <span>{entry.readingTime || 1} min read</span>
            <a href={entry.url} target="_blank" rel="noopener noreferrer">Original <ExternalLink size={13} /></a>
          </div>
        </header>
        {entry.previewPicture ? <div className="reader-hero" style={{ backgroundImage: `url(${JSON.stringify(entry.previewPicture).slice(1, -1)})` }} /> : null}
        <div className="article-content" dangerouslySetInnerHTML={{ __html: entry.content }} />
      </article>
      <footer className="shared-footer">Saved and shared with Wallaby.</footer>
    </main>
  );
}
