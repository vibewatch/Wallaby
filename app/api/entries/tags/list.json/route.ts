import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { parseEntryTagList, updateEntryTagsByUrl } from "@/lib/api-entry-lists";

export async function DELETE(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  try {
    const values = parseEntryTagList(new URL(request.url).searchParams.get("list"));
    return Response.json(await updateEntryTagsByUrl(userId, values, "remove-tags"));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid tag list" }, { status: 400 });
  }
}
