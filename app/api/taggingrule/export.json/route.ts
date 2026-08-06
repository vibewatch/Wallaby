import { GET as getTaggingRules } from "@/app/api/tagging-rules/route";

export async function GET(request: Request) {
  const url = new URL(request.url);
  url.pathname = "/api/tagging-rules";
  url.searchParams.set("download", "1");
  return getTaggingRules(new Request(url, { headers: request.headers }));
}
