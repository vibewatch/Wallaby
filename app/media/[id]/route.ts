import { readEntryImage } from "@/lib/article-images";
import { db } from "@/lib/db";

export const runtime = "nodejs";

type MediaRouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: MediaRouteContext) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return new Response("Not found", { status: 404 });
  const image = await db.entryImage.findUnique({ where: { id } });
  if (!image) return new Response("Not found", { status: 404 });
  const etag = `"${image.sha256}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: mediaHeaders(image.contentType, image.byteSize, etag) });
  }
  try {
    const bytes = await readEntryImage(image.relativePath);
    return new Response(new Uint8Array(bytes), { status: 200, headers: mediaHeaders(image.contentType, bytes.length, etag) });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

export async function HEAD(request: Request, context: MediaRouteContext) {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}

function mediaHeaders(contentType: string, length: number, etag: string): HeadersInit {
  return {
    "cache-control": "public, max-age=31536000, immutable",
    "content-length": String(length),
    "content-security-policy": "default-src 'none'; sandbox",
    "content-type": contentType,
    etag,
    "x-content-type-options": "nosniff",
  };
}
