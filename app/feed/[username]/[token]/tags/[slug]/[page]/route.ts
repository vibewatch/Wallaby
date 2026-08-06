import { renderPrivateFeed } from "@/lib/feed";

type Context = { params: Promise<{ username: string; token: string; slug: string; page: string }> };

export async function GET(request: Request, { params }: Context) {
  const { username, token, slug, page } = await params;
  return renderPrivateFeed(request, { username, token, tag: slug, page });
}
