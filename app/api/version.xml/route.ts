import { GET as getVersion } from "@/app/api/version/route";
import { xmlApiResponse } from "@/lib/api-response";

export async function GET() { return xmlApiResponse(getVersion(), "version"); }
