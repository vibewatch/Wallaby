import { randomBytes } from "node:crypto";

import { z } from "zod";

import { deleteEntriesWithMedia } from "@/lib/article-images";
import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { apiError, apiRequestObject, stripApiFormat, xmlApiResponse } from "@/lib/api-response";
import { db } from "@/lib/db";
import { serializeEntry } from "@/lib/entry-serializer";
import { parseTags, reloadEntry, slugify } from "@/lib/entries";
import { getGraby } from "@/lib/graby";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { id, format } = stripApiFormat((await context.params).id);
  const response = await getEntry(request, id);
  return format === "xml" ? xmlApiResponse(response, "entry") : response;
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id, format } = stripApiFormat((await context.params).id);
  const response = await patchEntry(request, id);
  return format === "xml" ? xmlApiResponse(response, "entry") : response;
}

export async function DELETE(request: Request, context: RouteContext) {
  const rawId = (await context.params).id;
  const { id, format } = stripApiFormat(rawId);
  const response = await deleteEntry(request, id, rawId !== id);
  return format === "xml" ? xmlApiResponse(response, "entry") : response;
}

async function getEntry(request: Request, id: string): Promise<Response> {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const detail = (new URL(request.url).searchParams.get("detail") ?? "full").toLowerCase();
  if (detail !== "full" && detail !== "metadata") return apiError(400, "invalid_parameter", `Detail “${detail}” is invalid; allowed: full or metadata`);
  const entry = await db.entry.findFirst({
    where: { id, userId },
    include: { tags: true, annotations: true, user: { select: { id: true, name: true, username: true, email: true } } },
  });
  return entry ? Response.json(serializeEntry(entry, { detail })) : apiError(404, "not_found", "Entry not found");
}

async function patchEntry(request: Request, id: string): Promise<Response> {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const current = await db.entry.findFirst({ where: { id, userId } });
  if (!current) return apiError(404, "not_found", "Entry not found");

  const parsed = entryPatch.safeParse(await apiRequestObject(request));
  if (!parsed.success) return apiError(400, "invalid_entry", "The entry patch is invalid", parsed.error.issues);
  if (parsed.data.reload) {
    try {
      const entry = await reloadEntry(userId, id);
      return Response.json(serializeEntry(entry));
    } catch { return new Response(null, { status: 304 }); }
  }

  const archived = parsed.data.archive === undefined ? current.archived : parsed.data.archive;
  const starred = parsed.data.starred === undefined ? current.starred : parsed.data.starred;
  const tags = parsed.data.tags === undefined ? undefined : parseTags(parsed.data.tags);
  const publishedAt = parsed.data.published_at === undefined ? undefined : parseApiDate(parsed.data.published_at);
  if (parsed.data.published_at !== undefined && !publishedAt) return apiError(400, "invalid_parameter", "published_at is invalid");
  const content = parsed.data.content === undefined ? undefined : getGraby().cleanupHtml(parsed.data.content, current.url);
  const shareToken = parsed.data.public === undefined ? undefined : parsed.data.public ? current.shareToken ?? randomBytes(24).toString("base64url") : null;
  const entry = await db.entry.update({
    where: { id },
    data: {
      title: parsed.data.title?.trim() || undefined,
      content,
      language: parsed.data.language,
      previewPicture: parsed.data.preview_picture,
      publishedAt,
      publishedBy: parsed.data.authors === undefined ? undefined : parseAuthors(parsed.data.authors),
      originUrl: parsed.data.origin_url === undefined ? undefined : parsed.data.origin_url || null,
      archived,
      archivedAt: archived ? current.archivedAt ?? new Date() : null,
      starred,
      starredAt: starred ? current.starredAt ?? new Date() : null,
      shareToken,
      sharedAt: parsed.data.public === undefined ? undefined : parsed.data.public ? current.sharedAt ?? new Date() : null,
      tags: tags ? {
        set: [],
        connectOrCreate: tags.map((label) => ({
          where: { userId_slug: { userId, slug: slugify(label) } },
          create: { userId, label, slug: slugify(label) },
        })),
      } : undefined,
    },
    include: { tags: true, annotations: true, user: { select: { id: true, name: true, username: true, email: true } } },
  });
  return Response.json(serializeEntry(entry));
}

async function deleteEntry(request: Request, id: string, compatibilityResponse: boolean): Promise<Response> {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const requestedExpect = new URL(request.url).searchParams.get("expect");
  const expect = requestedExpect ?? "entry";
  if (expect !== "entry" && expect !== "id") return apiError(400, "invalid_parameter", "expect must be entry or id");
  const current = await db.entry.findFirst({ where: { id, userId }, include: { tags: true, annotations: true, user: { select: { id: true, name: true, username: true, email: true } } } });
  if (!current) return apiError(404, "not_found", "Entry not found");
  await deleteEntriesWithMedia(userId, { id });
  if (!compatibilityResponse && !requestedExpect) return new Response(null, { status: 204 });
  return Response.json(expect === "id" ? { id } : serializeEntry(current));
}

const apiFlag = z.union([z.boolean(), z.number(), z.string()]).transform((value, context) => {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a boolean or 0/1" });
  return z.NEVER;
});

const entryPatch = z.object({
  title: z.string().max(10_000).optional(),
  archive: apiFlag.optional(),
  starred: apiFlag.optional(),
  public: apiFlag.optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  reload: apiFlag.optional(),
  content: z.string().max(10_000_000).optional(),
  language: z.string().max(50).optional(),
  preview_picture: z.string().url().max(2_000).optional(),
  published_at: z.union([z.string(), z.number()]).optional(),
  authors: z.union([z.string(), z.array(z.string())]).optional(),
  origin_url: z.string().url().max(2_000).nullable().or(z.literal("")).optional(),
});

function parseApiDate(value: string | number): Date | undefined {
  const date = typeof value === "number" || /^\d+$/.test(String(value)) ? new Date(Number(value) * 1_000) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseAuthors(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : value.split(",")).map((author) => author.trim()).filter(Boolean).slice(0, 100);
}
