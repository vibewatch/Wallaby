import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { stripHtml } from "@/lib/text";

/**
 * How many ranked candidates the index is asked for. Relevance order cannot be
 * expressed inside the relational query that applies the remaining filters, so
 * the ranked ids are re-applied in memory afterwards; the cap keeps that work
 * bounded. A library large enough to overflow it is well past the point where
 * the five-hundredth best match still matters.
 */
export const SEARCH_CANDIDATE_LIMIT = 500;

const MAX_TOKENS = 12;
const MAX_TOKEN_LENGTH = 64;
const SNIPPET_SCAN_LIMIT = 200_000;

/**
 * `index` means a full-text index answered the capability probe; `scan` means
 * the datasource has none and callers should fall back to substring matching.
 */
export type SearchEngine = "index" | "scan";

export type SearchTokens = { terms: string[]; phrases: string[] };

/** A snippet is returned as segments so the caller never has to trust HTML. */
export type SnippetPart = { text: string; match: boolean };

/**
 * Splits a search box entry into quoted phrases and bare words.
 *
 * Everything outside letters, digits, and underscores is discarded, which both
 * mirrors how the `unicode61` tokenizer splits indexed text and removes every
 * character that carries meaning in the FTS5 query grammar. That is what makes
 * the expression below safe to embed rather than escape.
 */
export function tokenizeSearch(term: string): SearchTokens {
  const phrases: string[] = [];
  const rest = term.slice(0, 500).replace(/"([^"]*)"/g, (_, quoted: string) => {
    const words = splitWords(quoted);
    if (words.length) phrases.push(words.join(" "));
    return " ";
  });
  const terms = splitWords(rest).filter((word) => !phrases.includes(word));
  return {
    phrases: [...new Set(phrases)].slice(0, MAX_TOKENS),
    terms: [...new Set(terms)].slice(0, MAX_TOKENS),
  };
}

/**
 * Builds an FTS5 `MATCH` expression. Bare words get a trailing `*` so typing
 * "portab" finds "portable" while the reader is still typing; quoted phrases
 * stay exact. Multiple parts are implicitly ANDed, which matches the
 * expectation that adding a word narrows the result.
 */
export function ftsMatchExpression(tokens: SearchTokens): string | null {
  const parts = [...tokens.phrases.map((phrase) => `"${phrase}"`), ...tokens.terms.map((word) => `"${word}"*`)];
  return parts.length ? parts.join(" ") : null;
}

let capability: Promise<SearchEngine> | null = null;

/**
 * Probes once for a usable index instead of inspecting the connection string.
 * A PostgreSQL deployment simply has no `EntrySearch` table, so the probe fails
 * and every caller degrades to portable matching without any provider check.
 */
export function searchEngine(): Promise<SearchEngine> {
  capability ??= probeSearchEngine();
  return capability;
}

/** Test seam: forget the probed capability so the next call re-probes. */
export function resetSearchEngine(): void {
  capability = null;
}

async function probeSearchEngine(): Promise<SearchEngine> {
  try {
    await db.$queryRaw`SELECT "entryId" FROM "EntrySearch" WHERE "EntrySearch" MATCH 'wallaby' LIMIT 1`;
    return "index";
  } catch {
    return "scan";
  }
}

/**
 * Returns candidate entry ids in relevance order, or `null` when the caller
 * should fall back to substring matching. Titles are weighted well above body
 * text so a search for a word in the headline outranks one buried in prose.
 */
export async function rankedEntryIds(userId: string, term: string, limit = SEARCH_CANDIDATE_LIMIT): Promise<string[] | null> {
  const tokens = tokenizeSearch(term);
  const match = ftsMatchExpression(tokens);
  if (!match || (await searchEngine()) !== "index") return null;

  let ranked: string[];
  try {
    const rows = await db.$queryRaw<{ entryId: string }[]>`
      SELECT "entryId" FROM "EntrySearch"
      WHERE "EntrySearch" MATCH ${match} AND "userId" = ${userId}
      ORDER BY bm25("EntrySearch", 0.0, 0.0, 10.0, 1.0, 4.0)
      LIMIT ${limit}
    `;
    ranked = rows.map((row) => row.entryId);
  } catch {
    // An expression the index refuses should quietly degrade to a portable
    // search rather than fail the page the reader asked for.
    return null;
  }

  // Tag labels are relational, so they are unioned in behind the ranked hits.
  // Searching for a tag the way you search for prose already worked before the
  // index existed, and losing it here would be a regression.
  const tagged = await db.entry.findMany({
    where: { userId, tags: { some: { label: { contains: term } } } },
    select: { id: true },
    take: limit,
  });
  return [...new Set([...ranked, ...tagged.map(({ id }) => id)])].slice(0, limit);
}

type EntryPageArgs = {
  where: Prisma.EntryWhereInput;
  /** Candidate ids in relevance order, or `null` to order by recency. */
  ranked: string[] | null;
  page: number;
  pageSize: number;
};

/**
 * Fetches one page of the library. Without a ranking the database paginates by
 * recency directly; with one, the filtered ids are re-sorted into relevance
 * order first, because no relational `ORDER BY` can express "the order this
 * list arrived in".
 */
export async function findEntryPage({ where, ranked, page, pageSize }: EntryPageArgs) {
  if (!ranked) {
    const [entries, total] = await Promise.all([
      db.entry.findMany({ where, include: { tags: true }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      db.entry.count({ where }),
    ]);
    return { entries, total };
  }

  const rank = new Map(ranked.map((id, index) => [id, index] as const));
  const matching = await db.entry.findMany({ where, select: { id: true } });
  matching.sort((first, second) => (rank.get(first.id) ?? ranked.length) - (rank.get(second.id) ?? ranked.length));
  const ids = matching.slice((page - 1) * pageSize, page * pageSize).map(({ id }) => id);
  const found = await db.entry.findMany({ where: { AND: [where, { id: { in: ids } }] }, include: { tags: true } });
  const byId = new Map(found.map((entry) => [entry.id, entry] as const));
  return { entries: ids.flatMap((id) => byId.get(id) ?? []), total: matching.length };
}

/**
 * Cuts a readable window around the first match so a result explains itself.
 * The window is taken from the stored HTML and stripped, then returned as
 * segments — highlighting by building markup would mean re-injecting article
 * HTML into the page.
 */
export function searchSnippet(content: string, tokens: SearchTokens, width = 180): SnippetPart[] | null {
  const needles = [...tokens.phrases, ...tokens.terms].filter(Boolean);
  if (!needles.length || !content) return null;
  const plain = stripHtml(content.slice(0, SNIPPET_SCAN_LIMIT));
  const lower = plain.toLowerCase();
  const first = needles.reduce((earliest, needle) => {
    const at = lower.indexOf(needle);
    return at !== -1 && (earliest === -1 || at < earliest) ? at : earliest;
  }, -1);
  if (first === -1) return null;

  const start = boundary(plain, Math.max(0, first - Math.floor(width / 3)), "forward");
  const end = boundary(plain, Math.min(plain.length, start + width), "back");
  const window = plain.slice(start, end);
  const lowerWindow = window.toLowerCase();

  const ranges: [number, number][] = [];
  for (const needle of needles) {
    for (let at = lowerWindow.indexOf(needle); at !== -1; at = lowerWindow.indexOf(needle, at + needle.length)) {
      ranges.push([at, at + needle.length]);
    }
  }
  ranges.sort((first, second) => first[0] - second[0]);

  const parts: SnippetPart[] = [];
  let cursor = 0;
  for (const [from, to] of ranges) {
    if (to <= cursor) continue;
    const at = Math.max(from, cursor);
    if (at > cursor) parts.push({ text: window.slice(cursor, at), match: false });
    parts.push({ text: window.slice(at, to), match: true });
    cursor = to;
  }
  if (cursor < window.length) parts.push({ text: window.slice(cursor), match: false });
  if (start > 0) parts.unshift({ text: "… ", match: false });
  if (end < plain.length) parts.push({ text: " …", match: false });
  return parts;
}

function splitWords(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).map((word) => word.slice(0, MAX_TOKEN_LENGTH));
}

/** Nudges an offset to the nearest word gap so a snippet never starts mid-word. */
function boundary(text: string, offset: number, direction: "forward" | "back"): number {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;
  const limit = 24;
  for (let step = 0; step < limit; step++) {
    const at = direction === "forward" ? offset + step : offset - step;
    if (at <= 0 || at >= text.length) return at <= 0 ? 0 : text.length;
    if (/\s/.test(text[at])) return direction === "forward" ? at + 1 : at;
  }
  return offset;
}
