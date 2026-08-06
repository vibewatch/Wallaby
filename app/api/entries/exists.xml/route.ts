import { GET as getExists } from "@/app/api/entries/exists/route";
import { xmlApiResponse } from "@/lib/api-response";

export async function GET(request: Request) { return xmlApiResponse(await getExists(request), "exists"); }
