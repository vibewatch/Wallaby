import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { parseEntryUrlList } from "@/lib/api-entry-lists";
import { deleteEntriesWithMedia } from "@/lib/article-images";
import { db } from "@/lib/db";

export async function DELETE(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  try {
    const values = parseEntryUrlList(new URL(request.url).searchParams.get("urls"));
    const results: { url: string; entry: boolean }[] = [];
    for (const value of values) {
      const entry = await db.entry.findFirst({ where: { userId, OR: [{ url: value.url }, { givenUrl: value.url }] }, select: { id: true } });
      results.push({ url: value.url, entry: Boolean(entry) });
      if (entry) await deleteEntriesWithMedia(userId, { id: entry.id });
    }
    await db.tag.deleteMany({ where: { userId, entries: { none: {} } } });
    return Response.json(results);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid URL list" }, { status: 400 });
  }
}
