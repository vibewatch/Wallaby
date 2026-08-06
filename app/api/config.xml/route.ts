import { GET as getConfig, PATCH as patchConfig } from "@/app/api/config/route";
import { xmlApiResponse } from "@/lib/api-response";

export async function GET(request: Request) { return xmlApiResponse(await getConfig(request), "config"); }
export async function PATCH(request: Request) { return xmlApiResponse(await patchConfig(request), "config"); }
