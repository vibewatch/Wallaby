import type { Fetcher, FetchRequestOptions, FetchResult, HeadersRecord } from "./types";
import { assertPublicUrl } from "./url";

export interface HttpFetcherOptions {
  maxRedirects: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  userAgent: string;
}

export class HttpFetcher implements Fetcher {
  constructor(private readonly options: HttpFetcherOptions) {}

  async fetch(url: URL, headers: HeadersRecord = {}, request: FetchRequestOptions = {}): Promise<FetchResult> {
    const cookieJar = new Map<string, string>();
    for (const cookie of request.cookies ?? []) putCookie(cookieJar, cookie);
    return this.request(url, headers, request, 0, cookieJar);
  }

  private async request(
    url: URL,
    headers: HeadersRecord,
    request: FetchRequestOptions,
    redirects: number,
    cookieJar: Map<string, string>,
  ): Promise<FetchResult> {
    await assertPublicUrl(url);

    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain,application/pdf,image/*;q=0.8,*/*;q=0.5",
        "accept-language": "en,*;q=0.5",
        "user-agent": this.options.userAgent,
        ...(cookieJar.size ? { cookie: [...cookieJar.values()].join("; ") } : {}),
        ...headers,
      },
      method: request.method ?? "GET",
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });

    const responseCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const cookie of responseCookies) putCookie(cookieJar, cookie);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect response ${response.status} did not include a Location header`);
      if (redirects >= this.options.maxRedirects) throw new Error("Too many redirects while fetching article");
      const preservePost = response.status === 307 || response.status === 308;
      return this.request(
        new URL(location, url),
        headers,
        preservePost ? request : { ...request, method: "GET", body: undefined },
        redirects + 1,
        cookieJar,
      );
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > this.options.maxResponseBytes) throw new Error("Article response is larger than the configured limit");
    if (!response.body) throw new Error("Article response did not include a body");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > this.options.maxResponseBytes) {
        await reader.cancel();
        throw new Error("Article response is larger than the configured limit");
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const mimeType = contentType.split(";", 1)[0].trim().toLowerCase() || null;

    return {
      body: decodeBody(bytes, contentType),
      bytes,
      url: response.url || url.toString(),
      status: response.status,
      headers: Object.fromEntries([...response.headers.entries()].filter(([name]) => name.toLowerCase() !== "set-cookie")),
      mimeType,
      setCookies: [...cookieJar.values()],
    };
  }
}

export function decodeBody(bytes: Uint8Array, contentType = ""): string {
  let charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1];
  if (!charset) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = "utf-16be";
    else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = "utf-8";
  }
  if (!charset) {
    const head = new TextDecoder("windows-1252").decode(bytes.slice(0, 50_000));
    charset = /^<\?xml\s+[^>]*encoding\s*=\s*["']([^"']+)/i.exec(head)?.[1];
    if (!charset) {
      for (const meta of head.match(/<meta\s+[^>]*>/gi) ?? []) {
        charset = /charset\s*=\s*["']?\s*([^;\s"'/>]+)/i.exec(meta)?.[1];
        if (charset) break;
      }
    }
  }
  charset = charset?.trim().toLowerCase().replace("iso-8850-1", "iso-8859-1") || "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function putCookie(jar: Map<string, string>, setCookie: string): void {
  const pair = setCookie.split(";", 1)[0]?.trim();
  const separator = pair?.indexOf("=") ?? -1;
  if (!pair || separator <= 0) return;
  jar.set(pair.slice(0, separator).trim(), pair);
}
