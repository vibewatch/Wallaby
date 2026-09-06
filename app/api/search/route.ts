import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { serializeEntry } from "@/lib/entry-serializer";
import { pageNumber, positiveInteger } from "@/lib/pagination";

export async function GET(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const params = new URL(request.url).searchParams;
  const term = params.get("term")?.trim() ?? "";
  const perPage = Math.min(100, positiveInteger(params.get("perPage") ?? params.get("per_page") ?? params.get("limit"), 30));
  const page = pageNumber(params.get("page"), perPage);
  const where = {
    userId,
    ...(term ? { OR: [{ title: { contains: term } }, { content: { contains: term } }, { url: { contains: term } }, { tags: { some: { label: { contains: term } } } }] } : {}),
  };
  const [entries, total] = await Promise.all([
    db.entry.findMany({
      where,
      include: { tags: true, annotations: true, user: { select: { id: true, name: true, username: true, email: true } } },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.entry.count({ where }),
  ]);
  const pages = Math.max(1, Math.ceil(total / perPage));
  return Response.json({
    page,
    limit: perPage,
    pages,
    total,
    _embedded: { items: entries.map((entry) => serializeEntry(entry)) },
    _links: {
      self: { href: pageLink(request, page, perPage) },
      first: { href: pageLink(request, 1, perPage) },
      last: { href: pageLink(request, pages, perPage) },
      ...(page > 1 ? { prev: { href: pageLink(request, page - 1, perPage) } } : {}),
      ...(page < pages ? { next: { href: pageLink(request, page + 1, perPage) } } : {}),
    },
  });
}

function pageLink(request: Request, page: number, perPage: number): string {
  const url = new URL(request.url);
  url.searchParams.set("page", String(page));
  url.searchParams.set("perPage", String(perPage));
  url.searchParams.delete("per_page");
  url.searchParams.delete("limit");
  return `${url.pathname}${url.search}`;
}
