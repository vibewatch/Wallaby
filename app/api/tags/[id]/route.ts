import { deleteApiTagById } from "@/lib/api-tags";
import { stripApiFormat, xmlApiResponse } from "@/lib/api-response";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Context) {
  const raw = (await params).id;
  const response = await deleteApiTagById(request, raw);
  return stripApiFormat(raw).format === "xml" ? xmlApiResponse(response, "tag") : response;
}
