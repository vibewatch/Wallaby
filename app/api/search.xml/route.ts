import { GET as getSearch } from "@/app/api/search/route";
import { xmlApiResponse } from "@/lib/api-response";

export async function GET(request: Request) { return xmlApiResponse(await getSearch(request), "search"); }
