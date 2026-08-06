import { GET as getInfo } from "@/app/api/info/route";
import { xmlApiResponse } from "@/lib/api-response";

export async function GET() { return xmlApiResponse(getInfo(), "info"); }
