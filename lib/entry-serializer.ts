import type { Annotation, Entry, Tag } from "@prisma/client";

type EntryWithRelations = Entry & {
  tags?: Tag[];
  annotations?: Annotation[];
  user?: { id: string; name: string | null; username: string; email: string | null };
};

export function serializeEntry(entry: EntryWithRelations, options: { detail?: "full" | "metadata" } = {}) {
  return {
    id: entry.id,
    uid: entry.uid,
    title: entry.title,
    url: entry.url,
    given_url: entry.givenUrl,
    origin_url: entry.originUrl,
    content: options.detail === "metadata" ? null : entry.content,
    summary: entry.summary,
    is_archived: Number(entry.archived),
    is_starred: Number(entry.starred),
    archived_at: entry.archivedAt?.toISOString() ?? null,
    starred_at: entry.starredAt?.toISOString() ?? null,
    created_at: entry.createdAt.toISOString(),
    updated_at: entry.updatedAt.toISOString(),
    published_at: entry.publishedAt?.toISOString() ?? null,
    published_by: entry.publishedBy ?? [],
    mimetype: entry.mimeType,
    language: entry.language,
    reading_time: entry.readingTime,
    domain_name: entry.domainName,
    preview_picture: entry.previewPicture,
    http_status: entry.httpStatus === null ? null : String(entry.httpStatus),
    headers: entry.headers,
    is_not_parsed: Number(entry.isNotParsed),
    is_public: Boolean(entry.shareToken),
    public_url: entry.shareToken ? `/share/${entry.shareToken}` : null,
    user_id: entry.user?.id ?? entry.userId,
    user_name: entry.user?.username ?? null,
    user_email: entry.user?.email ?? null,
    tags: entry.tags ?? [],
    annotations: entry.annotations ?? [],
    _links: {
      self: { href: `/api/entries/${entry.id}` },
      original: { href: entry.url },
    },
  };
}
