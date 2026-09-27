import { ArrowLeft, ArrowRight, Download, Search, Shuffle, SlidersHorizontal } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AddEntry } from "@/components/add-entry";
import { ActionForm } from "@/components/action-form";
import { EntryCard } from "@/components/entry-card";
import { TagInput } from "@/components/tag-input";
import { SortSelect } from "@/components/sort-select";
import { bulkUpdateEntries } from "@/lib/actions";
import { requireUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { tagSuggestions } from "@/lib/entries";
import { advancedFilterNames, parseEntryFilters } from "@/lib/entry-filters";
import { listQuery } from "@/lib/entry-list";
import { entryOrderBy, parseEntrySort } from "@/lib/entry-sort";
import { pageNumber } from "@/lib/pagination";
import { findEntryPage, resolveEntryQuery, tokenizeSearch } from "@/lib/search";

export const metadata: Metadata = { title: "Library" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const viewLabels: Record<string, { title: string; subtitle: string }> = {
  unread: { title: "Unread", subtitle: "Articles waiting for a quiet moment." },
  starred: { title: "Starred", subtitle: "The pieces you want close at hand." },
  archive: { title: "Archive", subtitle: "Everything you have finished reading." },
  all: { title: "All entries", subtitle: "Your complete reading library." },
  annotated: { title: "Annotated", subtitle: "Entries with notes and highlighted ideas." },
  untagged: { title: "Untagged", subtitle: "Entries still waiting to be organized." },
  "same-domain": { title: "Same domain", subtitle: "More saved reading from this publication." },
};

export default async function EntriesPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const params = await searchParams;
  const filters = parseEntryFilters(params);
  const { view, query, tag, sourceEntryId, domain, language } = filters;
  const [preference, sourceEntry] = await Promise.all([
    db.userPreference.findUnique({ where: { userId: user.id } }),
    view === "same-domain" && sourceEntryId
      ? db.entry.findFirst({ where: { id: sourceEntryId, userId: user.id }, select: { domainName: true } })
      : null,
  ]);
  const pageSize = Math.min(preference?.itemsPerPage ?? 20, 100);
  const page = pageNumber(typeof params.page === "string" ? params.page : undefined, pageSize);

  const { where, ranked } = await resolveEntryQuery(user.id, filters, {
    readingSpeed: preference?.readingSpeed,
    sameDomain: sourceEntry?.domainName,
  });
  const highlight = query ? tokenizeSearch(query) : null;
  const sort = parseEntrySort(params.sort, Boolean(query));
  const list = listQuery(params);

  const [{ entries, total }, selectedTag, languageRows, tagLabels] = await Promise.all([
    findEntryPage({ where, ranked: sort === "relevance" ? ranked : null, orderBy: entryOrderBy(sort), page, pageSize, includeContent: Boolean(query) }),
    tag ? db.tag.findFirst({ where: { userId: user.id, slug: tag } }) : null,
    db.entry.findMany({ where: { userId: user.id, language: { not: null } }, distinct: ["language"], select: { language: true }, orderBy: { language: "asc" } }),
    tagSuggestions(user.id),
  ]);
  const label = selectedTag
    ? { title: `#${selectedTag.label}`, subtitle: "Entries filed with this tag." }
    : view === "same-domain" && sourceEntry?.domainName
      ? { title: sourceEntry.domainName, subtitle: "Saved entries from the same domain." }
      : viewLabels[view];
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const hasAdvancedFilters = advancedFilterNames.some((name) => Boolean(stringValue(params[name])));

  return (
    <div className="library-page">
      <header className="library-header">
        <div><p className="eyebrow">Your library</p><h1>{label.title}</h1><p>{label.subtitle}</p></div>
        <AddEntry tagSuggestions={tagLabels} />
      </header>
      <form className="search-bar">
        <Search size={18} />
        <input name="q" defaultValue={query} placeholder={'Search titles, content, domains, and tags — "quote a phrase"'} aria-label="Search your library" />
        <input type="hidden" name="view" value={view} />
        {tag ? <input type="hidden" name="tag" value={tag} /> : null}
        {sourceEntryId ? <input type="hidden" name="entry" value={sourceEntryId} /> : null}
        {advancedFilterNames.map((name) => stringValue(params[name]) ? <input key={name} type="hidden" name={name} value={stringValue(params[name])} /> : null)}
        {sort !== "newest" && sort !== "relevance" ? <input type="hidden" name="sort" value={sort} /> : null}
        <kbd>/</kbd>
        <kbd>Enter</kbd>
      </form>
      <details className="advanced-filters" open={hasAdvancedFilters}>
        <summary><SlidersHorizontal size={15} /> Advanced filters{hasAdvancedFilters ? <small>Active</small> : null}</summary>
        <form className="advanced-filter-form">
          <input type="hidden" name="view" value={view} />
          {query ? <input type="hidden" name="q" value={query} /> : null}
          {tag ? <input type="hidden" name="tag" value={tag} /> : null}
          {sourceEntryId ? <input type="hidden" name="entry" value={sourceEntryId} /> : null}
          {sort !== "newest" && sort !== "relevance" ? <input type="hidden" name="sort" value={sort} /> : null}
          <div className="advanced-filter-grid">
            <label><span>Reading time from</span><input type="number" min="0" name="minRead" defaultValue={stringValue(params.minRead)} placeholder="minutes" /></label>
            <label><span>Reading time to</span><input type="number" min="0" name="maxRead" defaultValue={stringValue(params.maxRead)} placeholder="minutes" /></label>
            <label><span>Saved from</span><input type="date" name="createdFrom" defaultValue={stringValue(params.createdFrom)} /></label>
            <label><span>Saved to</span><input type="date" name="createdTo" defaultValue={stringValue(params.createdTo)} /></label>
            <label><span>Published from</span><input type="date" name="publishedFrom" defaultValue={stringValue(params.publishedFrom)} /></label>
            <label><span>Published to</span><input type="date" name="publishedTo" defaultValue={stringValue(params.publishedTo)} /></label>
            <label><span>Domain contains</span><input name="domain" defaultValue={domain} placeholder="example.com" /></label>
            <label><span>Language</span><select name="language" defaultValue={language}><option value="">Any language</option>{languageRows.map(({ language: value }) => value ? <option value={value} key={value}>{value}</option> : null)}</select></label>
            <label><span>HTTP status</span><input type="number" min="100" max="599" name="httpStatus" defaultValue={stringValue(params.httpStatus)} placeholder="200" /></label>
          </div>
          <div className="advanced-filter-checks">
            <label><input type="checkbox" name="notParsed" value="1" defaultChecked={stringValue(params.notParsed) === "1"} /> Extraction failed</label>
            <label><input type="checkbox" name="hasPreview" value="1" defaultChecked={stringValue(params.hasPreview) === "1"} /> Has preview image</label>
            <label><input type="checkbox" name="hasAnnotations" value="1" defaultChecked={stringValue(params.hasAnnotations) === "1"} /> Has notes</label>
            <label><input type="checkbox" name="isShared" value="1" defaultChecked={stringValue(params.isShared) === "1"} /> Publicly shared</label>
          </div>
          <div className="advanced-filter-actions"><Link href={clearFilterUrl(view, tag, sourceEntryId)}>Clear filters</Link><button className="secondary-button">Apply filters</button></div>
        </form>
      </details>
      <div className="results-line"><span>{total} {total === 1 ? "entry" : "entries"}</span><SortSelect value={sort === "relevance" && !ranked ? "newest" : sort} searching={Boolean(query)} params={sortParams(params)} /><Link href={resultsUrl("/entries/random", params)}><Shuffle size={13} /> Read a random entry</Link><Link href={resultsUrl("/export/json", params)}><Download size={13} /> Export results</Link></div>
      {entries.length ? <ActionForm action={bulkUpdateEntries} id="bulk-entries" className="bulk-toolbar" confirmation={{ field: "action", value: "delete", message: "Delete the selected entries? This removes their saved copies and cannot be undone." }}>
        <label><span>Selected entries</span><select name="action" defaultValue="toggle-read" aria-label="Bulk action">
          <option value="toggle-read">Toggle read / unread</option>
          <option value="toggle-star">Toggle star</option>
          <option value="tag">Update tags</option>
          <option value="refetch">Fetch again</option>
          <option value="delete">Delete</option>
        </select></label>
        <TagInput name="tags" placeholder="Tags: research, -later" label="Bulk tags" suggestions={tagLabels} />
        <button className="secondary-button">Apply</button>
      </ActionForm> : null}
      <section className="entry-list" aria-live="polite">
        {entries.map((entry) => <EntryCard
          key={entry.id}
          entry={entry}
          list={list}
          selectionFormId="bulk-entries"
          highlight={highlight}
          compact={preference?.listMode ?? false}
          displayThumbnail={preference?.displayThumbnails ?? true}
          readingSpeed={preference?.readingSpeed ?? 200}
        />)}
        {!entries.length ? (
          <div className="empty-state"><span>∿</span><h2>{query ? "No matching entries" : "A clear reading list"}</h2><p>{query ? "Try a broader search or another filter." : "Save an article when you find something worth returning to."}</p></div>
        ) : null}
      </section>
      {pages > 1 ? (
        <nav className="pagination" aria-label="Pagination">
          <Link aria-disabled={page === 1} href={pageUrl(params, page - 1)}><ArrowLeft size={16} /> Previous</Link>
          <span>Page {page} of {pages}</span>
          <Link aria-disabled={page === pages} href={pageUrl(params, page + 1)}>Next <ArrowRight size={16} /></Link>
        </nav>
      ) : null}
    </div>
  );
}

function pageUrl(params: Record<string, string | string[] | undefined>, page: number): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (typeof value === "string" && key !== "page") query.set(key, value);
  query.set("page", String(page));
  return `/entries?${query}`;
}

/** Everything that selects the current results, minus the order and page. */
function sortParams(params: Record<string, string | string[] | undefined>): [string, string][] {
  return Object.entries(params).flatMap(([key, value]) => typeof value === "string" && value && key !== "page" && key !== "sort" ? [[key, value] as [string, string]] : []);
}

function stringValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function clearFilterUrl(view: string, tag: string, entry: string): string {
  const query = new URLSearchParams({ view });
  if (tag) query.set("tag", tag);
  if (entry) query.set("entry", entry);
  return `/entries?${query}`;
}

function resultsUrl(path: string, params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (typeof value === "string" && key !== "page") query.set(key, value);
  query.set("view", parseEntryFilters(params).view);
  return `${path}?${query}`;
}
