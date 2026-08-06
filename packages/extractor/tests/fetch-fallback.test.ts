import { afterEach, describe, expect, it, vi } from "vitest";

import { FetchHttpError, HttpFetcher } from "../src";

const encoder = new TextEncoder();
const PUBLIC = "https://93.184.216.34";
const CHALLENGE_HTML = "<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing</body></html>";
const REAL_HTML = "<!doctype html><html><body><article><p>a</p><p>b</p><p>c</p></article></body></html>";

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

type Stub = { status?: number; headers?: Record<string, string>; body?: string };

function makeResponse(url: string, stub: Stub) {
  const bytes = encoder.encode(stub.body ?? "");
  const headers = new Map(Object.entries(stub.headers ?? { "content-type": "text/html" }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: stub.status ?? 200,
    url,
    body: streamOf(bytes),
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      getSetCookie: () => [],
      entries: () => headers.entries(),
      [Symbol.iterator]: () => headers.entries(),
    },
  };
}

function installFetch(route: (url: string, init: RequestInit) => Stub) {
  const requests: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit) => {
    const url = input.toString();
    requests.push({ url, init });
    return makeResponse(url, route(url, init));
  });
  return requests;
}

const base = { maxRedirects: 5, maxResponseBytes: 1_000_000, requestTimeoutMs: 5_000, userAgent: "default-ua/1.0" };

describe("HttpFetcher bot-challenge fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not rotate profiles when the feature is off (single request)", async () => {
    const requests = installFetch(() => ({ status: 403, body: CHALLENGE_HTML }));
    const result = await new HttpFetcher(base).fetch(new URL(`${PUBLIC}/a`));
    expect(result.status).toBe(403); // returned as-is, no escalation
    expect(requests).toHaveLength(1);
  });

  it("rotates through search-bot profiles until one succeeds", async () => {
    const uas: string[] = [];
    installFetch((_url, init) => {
      const ua = (init.headers as Record<string, string>)["user-agent"];
      uas.push(ua);
      // Challenge everyone except the Googlebot identity.
      return ua.includes("Googlebot") ? { status: 200, body: REAL_HTML } : { status: 403, body: CHALLENGE_HTML };
    });
    const result = await new HttpFetcher({ ...base, botProfiles: true }).fetch(new URL(`${PUBLIC}/a`));
    expect(result.body).toContain("<article>");
    expect(uas[0]).toBe("default-ua/1.0"); // origin attempt first
    expect(uas.some((ua) => ua.includes("Googlebot"))).toBe(true);
  });

  it("treats a 200 interstitial as a challenge and escalates", async () => {
    let calls = 0;
    installFetch((_url, init) => {
      calls += 1;
      const ua = (init.headers as Record<string, string>)["user-agent"];
      return ua.includes("bingbot") ? { status: 200, body: REAL_HTML } : { status: 200, body: CHALLENGE_HTML };
    });
    const result = await new HttpFetcher({ ...base, botProfiles: true }).fetch(new URL(`${PUBLIC}/a`));
    expect(result.body).toContain("<article>");
    expect(calls).toBeGreaterThan(1);
  });

  it("falls back to the browser renderer when every profile is challenged", async () => {
    installFetch(() => ({ status: 403, body: CHALLENGE_HTML }));
    const render = vi.fn(async () => ({ status: 200, html: REAL_HTML }));
    const result = await new HttpFetcher({ ...base, botProfiles: true, browserRender: true, render }).fetch(new URL(`${PUBLIC}/a`));
    expect(render).toHaveBeenCalledOnce();
    expect(result.body).toContain("<article>");
    expect(result.mimeType).toBe("text/html");
  });

  it("throws a FetchHttpError when the whole chain stays challenged", async () => {
    installFetch(() => ({ status: 403, body: CHALLENGE_HTML }));
    const render = vi.fn(async () => ({ status: 403, html: CHALLENGE_HTML }));
    await expect(
      new HttpFetcher({ ...base, botProfiles: true, browserRender: true, render }).fetch(new URL(`${PUBLIC}/a`)),
    ).rejects.toBeInstanceOf(FetchHttpError);
  });

  it("does NOT run the chain for POST/login requests", async () => {
    const requests = installFetch(() => ({ status: 403, body: CHALLENGE_HTML }));
    const result = await new HttpFetcher({ ...base, botProfiles: true }).fetch(new URL(`${PUBLIC}/login`), {}, { method: "POST", body: "u=1" });
    expect(result.status).toBe(403);
    expect(requests).toHaveLength(1); // no profile rotation on a POST
  });

  it("does not escalate on a genuine 404 (real not-found, not a challenge)", async () => {
    const requests = installFetch(() => ({ status: 404, body: "<html><body>gone</body></html>" }));
    const result = await new HttpFetcher({ ...base, botProfiles: true }).fetch(new URL(`${PUBLIC}/missing`));
    expect(result.status).toBe(404);
    expect(requests).toHaveLength(1);
  });
});
