import { DELETE as deleteTags } from "@/app/api/tags/label/route";
import { xmlApiResponse } from "@/lib/api-response";

export async function DELETE(request: Request) { return xmlApiResponse(await deleteTags(request), "tags"); }
