import { DELETE as deleteTag } from "@/app/api/tag/label/route";
import { xmlApiResponse } from "@/lib/api-response";

export async function DELETE(request: Request) { return xmlApiResponse(await deleteTag(request), "tag"); }
