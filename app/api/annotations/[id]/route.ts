import { z } from "zod";

import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { apiError, apiRequestObject, stripApiFormat, xmlApiResponse } from "@/lib/api-response";
import { db } from "@/lib/db";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const parsed = stripApiFormat((await context.params).id);
  const response = await getAnnotations(request, parsed.id);
  return parsed.format === "xml" ? xmlApiResponse(response, "annotations") : response;
}

export async function POST(request: Request, context: RouteContext) {
  const parsed = stripApiFormat((await context.params).id);
  const response = await postAnnotation(request, parsed.id);
  return parsed.format === "xml" ? xmlApiResponse(response, "annotation") : response;
}

export async function PUT(request: Request, context: RouteContext) {
  const parsed = stripApiFormat((await context.params).id);
  const response = await putAnnotation(request, parsed.id);
  return parsed.format === "xml" ? xmlApiResponse(response, "annotation") : response;
}

export async function DELETE(request: Request, context: RouteContext) {
  const parsed = stripApiFormat((await context.params).id);
  const response = await deleteAnnotation(request, parsed.id);
  return parsed.format === "xml" ? xmlApiResponse(response, "annotation") : response;
}

async function getAnnotations(request: Request, entryId: string): Promise<Response> {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const entry = await db.entry.findFirst({ where: { id: entryId, userId }, select: { id: true } });
  if (!entry) return apiError(404, "not_found", "Entry not found");
  return Response.json(await db.annotation.findMany({ where: { entryId, userId }, orderBy: { createdAt: "asc" } }));
}

async function postAnnotation(request: Request, entryId: string): Promise<Response> {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const parsed = annotationInput.safeParse(await apiRequestObject(request));
  if (!parsed.success) return apiError(400, "invalid_annotation", "The annotation payload is invalid", parsed.error.issues);
  const entry = await db.entry.findFirst({ where: { id: entryId, userId }, select: { id: true } });
  if (!entry) return apiError(404, "not_found", "Entry not found");
  return Response.json(await db.annotation.create({ data: { userId, entryId, ...parsed.data } }), { status: 201 });
}

async function putAnnotation(request: Request, id: string): Promise<Response> {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const parsed = annotationInput.partial().safeParse(await apiRequestObject(request));
  if (!parsed.success) return apiError(400, "invalid_annotation", "The annotation payload is invalid", parsed.error.issues);
  const annotation = await db.annotation.findFirst({ where: { id, userId } });
  if (!annotation) return apiError(404, "not_found", "Annotation not found");
  return Response.json(await db.annotation.update({ where: { id }, data: parsed.data }));
}

async function deleteAnnotation(request: Request, id: string): Promise<Response> {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const annotation = await db.annotation.findFirst({ where: { id, userId } });
  if (!annotation) return apiError(404, "not_found", "Annotation not found");
  await db.annotation.delete({ where: { id } });
  return Response.json(annotation);
}

const range = z.object({ start: z.string(), startOffset: z.coerce.number().int().nonnegative(), end: z.string(), endOffset: z.coerce.number().int().nonnegative() });
const annotationInput = z.object({
  text: z.string().min(1).max(10_000),
  quote: z.string().max(10_000).default(""),
  ranges: z.union([z.array(range), z.string().transform((value, context) => {
    try { return z.array(range).parse(JSON.parse(value)); }
    catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "ranges must be valid JSON" }); return z.NEVER; }
  })]).default([]),
});
