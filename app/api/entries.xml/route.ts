import { GET as getEntries, POST as postEntry } from "@/app/api/entries/route";
import { xmlApiResponse } from "@/lib/api-response";

export async function GET(request: Request) { return xmlApiResponse(await getEntries(request), "entries"); }
export async function POST(request: Request) { return xmlApiResponse(await postEntry(request), "entry"); }
