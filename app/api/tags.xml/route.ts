import { DELETE as deleteTag, GET as getTags } from "@/app/api/tags/route";
import { xmlApiResponse } from "@/lib/api-response";

export async function GET(request: Request) { return xmlApiResponse(await getTags(request), "tags"); }
export async function DELETE(request: Request) { return xmlApiResponse(await deleteTag(request), "tag"); }
