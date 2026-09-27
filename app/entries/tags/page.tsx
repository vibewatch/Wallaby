import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import { requireUser } from "@/lib/auth-user";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Tags" };

type Order = "name" | "count";

export default async function TagsPage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; order?: string | string[] }> }) {
  const user = await requireUser();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim().slice(0, 200) : "";
  const order: Order = params.order === "count" ? "count" : "name";
  const [tags, total] = await Promise.all([
    db.tag.findMany({
      where: { userId: user.id, ...(query ? { label: { contains: query } } : {}) },
      select: { id: true, label: true, slug: true, _count: { select: { entries: true } } },
      orderBy: order === "count" ? [{ entries: { _count: "desc" } }, { label: "asc" }] : { label: "asc" },
      take: 5_000,
    }),
    db.tag.count({ where: { userId: user.id } }),
  ]);
  const groups = order === "name" ? groupByInitial(tags) : [{ initial: "", tags }];

  return (
    <div className="settings-page tags-page">
      <header className="settings-header">
        <p className="eyebrow">Your library, by subject</p>
        <h1>Tags</h1>
        <p>{total} {total === 1 ? "tag" : "tags"}. <Link href="/entries/settings#tags">Rename, merge, or delete tags</Link></p>
      </header>
      {total ? (
        <Form action="/entries/tags" className="tags-toolbar">
          <input type="search" name="q" defaultValue={query} placeholder="Find a tag" aria-label="Find a tag" />
          <select name="order" defaultValue={order} aria-label="Order tags">
            <option value="name">A to Z</option>
            <option value="count">Most used</option>
          </select>
          <button className="secondary-button">Show</button>
        </Form>
      ) : null}
      {tags.length ? groups.map((group) => (
        <section className="tag-index" key={group.initial || "all"} aria-label={group.initial ? `Tags starting with ${group.initial}` : "Tags by use"}>
          {group.initial ? <h2>{group.initial}</h2> : null}
          <ul>
            {group.tags.map((tag) => (
              <li key={tag.id}>
                <Link href={`/entries?view=all&tag=${encodeURIComponent(tag.slug)}`}>
                  <span>{tag.label}</span><small>{tag._count.entries}</small>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )) : (
        <p className="muted">{total ? `No tags match “${query}”.` : "No tags yet. Add tags to an entry from the reader, or set up automatic tags in Settings."}</p>
      )}
    </div>
  );
}

function groupByInitial<T extends { label: string }>(tags: T[]): { initial: string; tags: T[] }[] {
  // SQLite orders by byte value, which puts every capitalised label first.
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const groups = new Map<string, T[]>();
  for (const tag of [...tags].sort((a, b) => collator.compare(a.label, b.label))) {
    const first = tag.label.trim().charAt(0).normalize("NFD").replace(/\p{M}/gu, "").toLocaleUpperCase();
    const initial = /\p{L}/u.test(first) ? first : "#";
    const group = groups.get(initial);
    if (group) group.push(tag);
    else groups.set(initial, [tag]);
  }
  // Labels starting with a digit or symbol go last rather than first.
  return [...groups].map(([initial, grouped]) => ({ initial, tags: grouped })).sort((a, b) => Number(a.initial === "#") - Number(b.initial === "#"));
}
