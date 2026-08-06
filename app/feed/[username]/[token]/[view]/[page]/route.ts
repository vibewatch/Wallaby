import { renderPrivateFeed } from "@/lib/feed";

type Context = { params: Promise<{ username: string; token: string; view: string; page: string }> };

export async function GET(request: Request, { params }: Context) {
  const { username, token, view, page } = await params;
  return renderPrivateFeed(request, { username, token, view, page });
}
