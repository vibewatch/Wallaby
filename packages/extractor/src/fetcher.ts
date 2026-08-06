import type { Fetcher, FetchRequestOptions, FetchResult, HeadersRecord } from "./types";
import { assertPublicUrl } from "./url";
import { BOT_CHALLENGE_STATUSES, looksLikeBotChallenge, SEARCH_BOT_PROFILES } from "./bot-profiles";
import { renderViaBrowser, type RenderOptions } from "./browser";

export interface HttpFetcherOptions {
  maxRedirects: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  userAgent: string;
  defaultReferer?: string;
  rewriteUrl?: Record<string, Record<string, string>>;
  userAgents?: Record<string, string>;
  // When true, a bot-challenged GET is retried with rotating search-bot /
  // browser request profiles before failing. Defaults to off.
  botProfiles?: boolean;
  // When true, a still-challenged GET is finally rendered in a headless browser.
  // Requires the optional `playwright` dependency. Defaults to off.
  browserRender?: boolean;
  // Injectable browser render hook (defaults to the Playwright renderer); lets
  // tests exercise the fallback without launching real Chromium.
  render?: (url: URL, timeoutMs: number, options?: RenderOptions) => Promise<{ status: number; html: string }>;
}

/** Raised when a fetch ends on a bot-challenge status, so the fallback chain can catch it. */
export class FetchHttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`Request to "${url}" failed with status ${status}`);
    this.name = "FetchHttpError";
  }
}

// Mirrors HttpClientConfig::$rewrite_url defaults.
const defaultRewriteUrl: Record<string, Record<string, string>> = {
  "docs.google.com": { "/Doc?": "/View?" },
  "tnr.com": { "tnr.com/article/": "tnr.com/print/article/" },
  ".m.wikipedia.org": { ".m.wikipedia.org": ".wikipedia.org" },
  "m.vanityfair.com": { "m.vanityfair.com": "www.vanityfair.com" },
};

const defaultReferer = "http://www.google.co.uk/url?sa=t&source=web&cd=1";

export class HttpFetcher implements Fetcher {
  constructor(private readonly options: HttpFetcherOptions) {}

  async fetch(url: URL, headers: HeadersRecord = {}, request: FetchRequestOptions = {}): Promise<FetchResult> {
    const cookieJar = new Map<string, string>();
    for (const cookie of request.cookies ?? []) putCookie(cookieJar, cookie);
    const cleanUrl = this.cleanupUrl(url);
    const baseHeaders = lowerCaseKeys(headers);

    // The bot-challenge fallback chain only applies to plain GET article
    // fetches. Login POSTs and any request carrying an explicit body/cookies or
    // a caller-provided user-agent go straight through unchanged.
    const method = request.method ?? "GET";
    const eligibleForChain = method === "GET" && !request.body && !baseHeaders["user-agent"] && (this.options.botProfiles || this.options.browserRender);
    if (!eligibleForChain) {
      return this.request(cleanUrl, baseHeaders, request, 0, cookieJar, 0);
    }

    return this.fetchWithChain(cleanUrl, baseHeaders, request, cookieJar);
  }

  // origin -> rotating search-bot/browser profiles -> headless browser render.
  private async fetchWithChain(url: URL, baseHeaders: HeadersRecord, request: FetchRequestOptions, cookieJar: Map<string, string>): Promise<FetchResult> {
    const attempts: HeadersRecord[] = [baseHeaders];
    if (this.options.botProfiles) {
      for (const profile of SEARCH_BOT_PROFILES) attempts.push({ ...baseHeaders, ...lowerCaseKeys(profile.headers) });
    }

    let firstChallenge: unknown = null;
    for (const headers of attempts) {
      try {
        const result = await this.request(url, headers, request, 0, new Map(cookieJar), 0);
        if (this.isChallengeResult(result)) {
          firstChallenge ??= new FetchHttpError(result.status || 403, url.toString());
          continue;
        }
        return result;
      } catch (error) {
        if (!isBotChallenge(error)) throw error; // genuine 404, SSRF, timeout, etc.
        firstChallenge ??= error;
      }
    }

    if (this.options.browserRender) {
      const render = this.options.render ?? renderViaBrowser;
      const { status, html } = await render(url, this.options.requestTimeoutMs);
      if (status < 400 && !looksLikeBotChallenge(html, status)) {
        return {
          body: html,
          url: url.toString(),
          status: status || 200,
          headers: { "content-type": "text/html" },
          mimeType: "text/html",
          setCookies: [...cookieJar.values()],
        };
      }
      firstChallenge ??= new FetchHttpError(status || 403, url.toString());
    }

    throw firstChallenge ?? new Error(`All fetch strategies failed for ${url.toString()}`);
  }

  private isChallengeResult(result: FetchResult): boolean {
    if (BOT_CHALLENGE_STATUSES.has(result.status)) return true;
    // A 200 can still carry an interstitial challenge page.
    return Boolean(result.mimeType?.includes("html")) && looksLikeBotChallenge(result.body, result.status);
  }


  private cleanupUrl(url: URL): URL {
    let value = url.toString();
    const rewrites = { ...defaultRewriteUrl, ...this.options.rewriteUrl };
    for (const [needle, replacements] of Object.entries(rewrites)) {
      if (value.includes(needle)) {
        for (const [find, replace] of Object.entries(replacements)) value = value.split(find).join(replace);
      }
    }
    return new URL(value);
  }

  private userAgent(url: URL, headers: HeadersRecord): string {
    if (headers["user-agent"]) return headers["user-agent"];
    const agents = this.options.userAgents ?? {};
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    const labels = host.split(".");
    const candidates = [host];
    if (labels.length > 1) candidates.push(`.${labels.slice(1).join(".")}`);
    for (const candidate of candidates) if (agents[candidate]) return agents[candidate];
    return this.options.userAgent;
  }

  private async request(
    url: URL,
    headers: HeadersRecord,
    request: FetchRequestOptions,
    redirects: number,
    cookieJar: Map<string, string>,
    metaRefreshes: number,
  ): Promise<FetchResult> {
    await assertPublicUrl(url);

    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain,application/pdf,image/*;q=0.8,*/*;q=0.5",
        "accept-language": "en,*;q=0.5",
        "user-agent": this.userAgent(url, headers),
        referer: this.options.defaultReferer ?? defaultReferer,
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
        this.cleanupUrl(new URL(location, url)),
        headers,
        preservePost ? request : { ...request, method: "GET", body: undefined },
        redirects + 1,
        cookieJar,
        metaRefreshes,
      );
    }

    // HTTP `Refresh` header behaves like a client-side redirect.
    const refresh = response.headers.get("refresh");
    const refreshUrl = refresh ? /[0-9];\s*url=["']?([^"'>]+)/i.exec(refresh)?.[1] : undefined;
    if (refreshUrl && metaRefreshes < this.options.maxRedirects) {
      await response.body?.cancel().catch(() => {});
      return this.request(this.cleanupUrl(new URL(refreshUrl.replace(/&amp;/g, "&"), url)), headers, { ...request, method: "GET", body: undefined }, redirects, cookieJar, metaRefreshes + 1);
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
    const responseUrl = response.url || url.toString();

    // Meta-refresh redirect embedded in HTML (e.g. <meta http-equiv="refresh" content="0;url=...">).
    if (mimeType && mimeType.includes("html") && metaRefreshes < this.options.maxRedirects && !responseUrl.includes("_escaped_fragment_")) {
      const head = decodeBody(bytes.slice(0, 50_000), contentType);
      const metaRefresh = findMetaRefreshUrl(head, new URL(responseUrl));
      if (metaRefresh) {
        return this.request(this.cleanupUrl(metaRefresh), headers, { ...request, method: "GET", body: undefined }, redirects, cookieJar, metaRefreshes + 1);
      }
    }

    return {
      body: decodeBody(bytes, contentType),
      bytes,
      url: removeTrackers(responseUrl),
      status: response.status,
      headers: Object.fromEntries([...response.headers.entries()].filter(([name]) => name.toLowerCase() !== "set-cookie")),
      mimeType,
      setCookies: [...cookieJar.values()],
    };
  }
}

function lowerCaseKeys(headers: HeadersRecord): HeadersRecord {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function isBotChallenge(error: unknown): boolean {
  return error instanceof FetchHttpError && BOT_CHALLENGE_STATUSES.has(error.status);
}

function findMetaRefreshUrl(html: string, base: URL): URL | null {
  const match =
    /<meta\s+http-equiv=["']?refresh["']?\s+content=["']?[0-9];\s*url=["']?([^"'>]+)/i.exec(html) ??
    /<meta\s+content=["']?[0-9];\s*url=["']?([^"'>]+)["']?\s+http-equiv=["']?refresh/i.exec(html);
  if (!match) return null;
  try {
    return new URL(match[1].replace(/&amp;/g, "&").trim(), base);
  } catch {
    return null;
  }
}

// Mirror HttpClient::removeTrackersFromUrl — strip utm_*/mtm_* params and xtor=RSS fragment.
export function removeTrackers(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.replace(/&amp;/g, "&"));
  } catch {
    return rawUrl;
  }
  if (url.search) {
    const kept = [...url.searchParams.entries()].filter(([key]) => !key.startsWith("utm_") && !key.startsWith("mtm_"));
    url.search = "";
    for (const [key, value] of kept) url.searchParams.append(key, value);
  }
  if (url.hash.includes("xtor=RSS")) url.hash = "";
  return url.toString();
}

export function decodeBody(bytes: Uint8Array, contentType = ""): string {
  let charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1];
  if (!charset) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = "utf-16be";
    else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = "utf-8";
  }
  if (!charset || charset.toLowerCase() === "none") {
    const head = new TextDecoder("windows-1252").decode(bytes.slice(0, 50_000));
    charset = /^<\?xml\s+[^>]*encoding\s*=\s*["']([^"']+)/i.exec(head)?.[1];
    if (!charset) {
      const httpEquiv = /<meta\s+http-equiv\s*=\s*["']?Content-Type["']?\s+content\s*=\s*["'][^;]+;\s*charset=["']?([^;"'>]+)/i.exec(head);
      charset = httpEquiv?.[1];
    }
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
