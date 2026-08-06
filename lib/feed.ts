import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

export async function renderPrivateFeed(request: Request, input: { username: string; token: string; view?: string; tag?: string; page?: string }) {
  const user = await db.user.findUnique({ where: { username: input.username }, include: { preference: true } });
  if (!user?.preference || user.preference.feedToken !== input.token) return new Response("Feed not found", { status: 404 });
  const view = input.tag ? "tags" : input.view ?? "all";
  if (!input.tag && !["all", "unread", "archive", "starred"].includes(view)) return new Response("Feed not found", { status: 404 });
  const page = Math.max(1, Number(input.page ?? 1) || 1);
  const limit = Math.min(Math.max(user.preference.feedLimit, 1), 1_000);
  const where: Prisma.EntryWhereInput = {
    userId: user.id,
    archived: view === "unread" ? false : view === "archive" ? true : undefined,
    starred: view === "starred" ? true : undefined,
    tags: input.tag ? { some: { slug: input.tag } } : undefined,
  };
  const sort = new URL(request.url).searchParams.get("sort") === "updated" ? "updatedAt" : "createdAt";
  const [entries, total] = await Promise.all([
    db.entry.findMany({ where, orderBy: { [sort]: "desc" }, skip: (page - 1) * limit, take: limit }),
    db.entry.count({ where }),
  ]);
  const pages = Math.max(1, Math.ceil(total / limit));
  if (page > pages) return new Response("Feed page not found", { status: 404 });
  const url = new URL(request.url);
  const title = input.tag ? `Wallaby · tag #${input.tag}` : `Wallaby · ${view}`;
  const format = url.searchParams.get("format")?.toLowerCase() === "rss" ? "rss" : "atom";
  return format === "rss" ? rssResponse(entries, title, url) : atomResponse(entries, title, url, page, pages);
}

type FeedEntry = Awaited<ReturnType<typeof db.entry.findMany>>[number];

function atomResponse(entries: FeedEntry[], title: string, url: URL, page: number, pages: number): Response {
  const updated = entries[0]?.updatedAt ?? new Date(0);
  const pageUrl = (target: number) => {
    const next = new URL(url);
    const segments = next.pathname.split("/").filter(Boolean);
    if (/^\d+$/.test(segments.at(-1) ?? "")) segments.pop();
    if (target > 1) segments.push(String(target));
    next.pathname = `/${segments.join("/")}`;
    return next.toString();
  };
  const links = [
    `<link href="${xml(url.toString())}" rel="self" />`,
    `<link href="${xml(pageUrl(1))}" rel="first" />`,
    `<link href="${xml(pageUrl(pages))}" rel="last" />`,
    page > 1 ? `<link href="${xml(pageUrl(page - 1))}" rel="previous" />` : "",
    page < pages ? `<link href="${xml(pageUrl(page + 1))}" rel="next" />` : "",
  ].join("");
  const items = entries.map((entry) => `<entry><id>${xml(entry.uid ?? entry.id)}</id><title>${xml(entry.title)}</title><link href="${xml(entry.url)}" rel="alternate" /><published>${entry.createdAt.toISOString()}</published><updated>${entry.updatedAt.toISOString()}</updated><summary>${xml(entry.summary ?? "")}</summary><content type="html"><![CDATA[${cdata(entry.content)}]]></content></entry>`).join("");
  return xmlResponse(`<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${xml(pageUrl(1))}</id><title>${xml(title)}</title><updated>${updated.toISOString()}</updated><generator>Wallaby</generator>${links}${items}</feed>`, "application/atom+xml");
}

function rssResponse(entries: FeedEntry[], title: string, url: URL): Response {
  const items = entries.map((entry) => `<item><guid isPermaLink="false">${xml(entry.uid ?? entry.id)}</guid><title>${xml(entry.title)}</title><link>${xml(entry.url)}</link><pubDate>${entry.createdAt.toUTCString()}</pubDate><description><![CDATA[${cdata(entry.content)}]]></description></item>`).join("");
  return xmlResponse(`<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>${xml(title)}</title><link>${xml(url.toString())}</link><description>${xml(title)} private reading feed</description>${items}</channel></rss>`, "application/rss+xml");
}

function xmlResponse(body: string, contentType: string): Response {
  return new Response(body, { headers: { "content-type": `${contentType}; charset=utf-8`, "cache-control": "private, max-age=60", "x-content-type-options": "nosniff" } });
}

function cdata(value: string): string {
  return value.replace(/]]>/g, "]]]]><![CDATA[>");
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}
