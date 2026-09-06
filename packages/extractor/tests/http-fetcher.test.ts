import { afterEach, describe, expect, it, vi } from "vitest";

import { Extractor, HttpFetcher, removeTrackers } from "../src";

const encoder = new TextEncoder();

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

type StubResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  url?: string;
  cookies?: string[];
};

// Build a minimal Response-like object matching what HttpFetcher reads.
function makeResponse(url: string, stub: StubResponse) {
  const bytes = typeof stub.body === "string" ? encoder.encode(stub.body) : stub.body ?? new Uint8Array();
  const headerMap = new Map(Object.entries(stub.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: stub.status ?? 200,
    url: stub.url ?? url,
    body: streamOf(bytes),
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
      getSetCookie: () => stub.cookies ?? [],
      entries: () => headerMap.entries(),
      [Symbol.iterator]: () => headerMap.entries(),
    },
  };
}

// Install a fake global fetch that serves a scripted map of url -> response,
// records the requests it received, and follows the fetcher's manual redirects.
function installFetch(routes: (url: string, init: RequestInit) => StubResponse) {
  const requests: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit) => {
    const url = input.toString();
    requests.push({ url, init });
    return makeResponse(url, routes(url, init));
  });
  return requests;
}

const options = { maxRedirects: 5, maxResponseBytes: 1_000_000, requestTimeoutMs: 5_000, userAgent: "test-agent/1.0" };

describe("HttpFetcher", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns decoded body, mime type, and status from a direct 200", async () => {
    installFetch(() => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<p>hi</p>" }));
    const result = await new HttpFetcher(options).fetch(new URL("https://93.184.216.34/a"));
    expect(result.status).toBe(200);
    expect(result.mimeType).toBe("text/html");
    expect(result.body).toContain("<p>hi</p>");
  });

  it("sends the configured user-agent and default referer", async () => {
    const requests = installFetch(() => ({ body: "ok" }));
    await new HttpFetcher({ ...options, defaultReferer: "https://ref.example/" }).fetch(new URL("https://93.184.216.34/a"));
    const headers = requests[0].init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe("test-agent/1.0");
    expect(headers.referer).toBe("https://ref.example/");
  });

  it("prefers a per-host user-agent override", async () => {
    const requests = installFetch(() => ({ body: "ok" }));
    await new HttpFetcher({ ...options, userAgents: { "93.184.216.34": "special-ua" } }).fetch(new URL("https://93.184.216.34/a"));
    expect((requests[0].init.headers as Record<string, string>)["user-agent"]).toBe("special-ua");
  });

  it("follows a 301 redirect via the Location header", async () => {
    const requests = installFetch((url) =>
      url.endsWith("/start")
        ? { status: 301, headers: { location: "https://93.184.216.34/final" } }
        : { status: 200, body: "landed" },
    );
    const result = await new HttpFetcher(options).fetch(new URL("https://93.184.216.34/start"));
    expect(result.body).toContain("landed");
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/start", "/final"]);
  });

  it("downgrades to GET on a 302 but preserves POST on a 307", async () => {
    const seen: { path: string; method?: string }[] = [];
    installFetch((url, init) => {
      seen.push({ path: new URL(url).pathname, method: init.method });
      if (url.endsWith("/p302")) return { status: 302, headers: { location: "https://93.184.216.34/after302" } };
      if (url.endsWith("/p307")) return { status: 307, headers: { location: "https://93.184.216.34/after307" } };
      return { status: 200, body: "done" };
    });
    await new HttpFetcher(options).fetch(new URL("https://93.184.216.34/p302"), {}, { method: "POST", body: "x=1" });
    await new HttpFetcher(options).fetch(new URL("https://93.184.216.34/p307"), {}, { method: "POST", body: "x=1" });
    expect(seen.find((s) => s.path === "/after302")?.method).toBe("GET");
    expect(seen.find((s) => s.path === "/after307")?.method).toBe("POST");
  });

  it("keeps cookies and sensitive headers out of unrelated redirect origins", async () => {
    const requests = installFetch((url) => url.endsWith("/start")
      ? { status: 302, headers: { location: "https://1.1.1.1/landing" }, cookies: ["session=private; Path=/; Secure"] }
      : { body: "arrived" });
    await new HttpFetcher(options).fetch(new URL("https://93.184.216.34/start"), { authorization: "Bearer test-only", cookie: "manual=private" });

    const redirected = new Headers(requests[1].init.headers);
    expect(redirected.get("cookie")).toBeNull();
    expect(redirected.get("authorization")).toBeNull();
  });

  it.each(["https://93.184.216.34/public", "http://93.184.216.34/account/final"])("respects cookie path and Secure attributes when redirecting to %s", async (destination) => {
    const requests = installFetch((url) => url.endsWith("/start")
      ? { status: 302, headers: { location: destination }, cookies: ["restricted=private; Path=/account; Secure"] }
      : { body: "arrived" });
    await new HttpFetcher(options).fetch(new URL("https://93.184.216.34/account/start"));
    expect(new Headers(requests[1].init.headers).get("cookie")).toBeNull();
  });

  it("does not replay a login POST body to a different origin", async () => {
    const requests = installFetch((url) => url.endsWith("/login")
      ? { status: 307, headers: { location: "https://1.1.1.1/collect" } }
      : { body: "should not receive the body" });
    await expect(new HttpFetcher(options).fetch(new URL("https://93.184.216.34/login"), {}, { method: "POST", body: "password=test-only" }))
      .rejects.toThrow("Refusing to forward a POST body across origins");
    expect(requests).toHaveLength(1);
  });

  it("carries a dynamic login session through the real HTTP transport", async () => {
    installFetch((url, init) => {
      const headers = new Headers(init.headers);
      if (url.endsWith("/session") && init.method === "GET") {
        return {
          headers: { "content-type": "text/html" },
          cookies: ["prelogin=csrf-session; Path=/; Secure; HttpOnly"],
          body: '<form><input name="csrf" value="session-bound-token"></form>',
        };
      }
      if (url.endsWith("/session")) {
        expect(headers.get("cookie")).toContain("prelogin=csrf-session");
        expect(init.body).toContain("csrf=session-bound-token");
        return { body: "signed in", cookies: ["authenticated=ready; Path=/reader; Secure; HttpOnly"] };
      }
      expect(headers.get("cookie")).toContain("authenticated=ready");
      return { headers: { "content-type": "text/html" }, body: "<article><p>The authenticated article is available.</p></article>" };
    });
    const extractor = new Extractor({
      siteConfigs: { "93.184.216.34.txt": [
        "requires_login: yes",
        "login_uri: /session",
        "login_username_field: username",
        "login_password_field: password",
        "login_extra_fields: csrf=@=xpath('//input[@name=\"csrf\"]/@value', request_html(config.getLoginUri()))",
        "body: //article",
      ].join("\n") },
    });
    const content = await extractor.fetchContent("https://93.184.216.34/reader/story", undefined, { username: "reader", password: "test-only" });
    expect(content.html).toContain("The authenticated article is available");
    expect(content.isNotParsed).toBe(false);
  });

  it("throws when redirects exceed the configured maximum", async () => {
    let n = 0;
    installFetch(() => ({ status: 302, headers: { location: `https://93.184.216.34/hop${n++}` } }));
    await expect(new HttpFetcher({ ...options, maxRedirects: 3 }).fetch(new URL("https://93.184.216.34/loop"))).rejects.toThrow(/Too many redirects/);
  });

  it("follows an HTTP Refresh header", async () => {
    const requests = installFetch((url) =>
      url.endsWith("/slow")
        ? { status: 200, headers: { refresh: "0; url=https://93.184.216.34/fast", "content-type": "text/html" }, body: "wait" }
        : { status: 200, body: "arrived" },
    );
    const result = await new HttpFetcher(options).fetch(new URL("https://93.184.216.34/slow"));
    expect(result.body).toContain("arrived");
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/slow", "/fast"]);
  });

  it("follows an HTML meta-refresh redirect", async () => {
    const requests = installFetch((url) =>
      url.endsWith("/meta")
        ? { status: 200, headers: { "content-type": "text/html" }, body: '<meta http-equiv="refresh" content="0;url=https://93.184.216.34/target">' }
        : { status: 200, body: "target page" },
    );
    const result = await new HttpFetcher(options).fetch(new URL("https://93.184.216.34/meta"));
    expect(result.body).toContain("target page");
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/meta", "/target"]);
  });

  it("strips utm_/mtm_ trackers from the effective URL", async () => {
    installFetch((url) => ({ status: 200, body: "ok", url }));
    const result = await new HttpFetcher(options).fetch(new URL("https://93.184.216.34/a?utm_source=x&keep=1&mtm_campaign=y"));
    expect(result.url).toBe("https://93.184.216.34/a?keep=1");
  });

  it("enforces the byte cap declared via content-length", async () => {
    installFetch(() => ({ status: 200, headers: { "content-length": "5000" }, body: "x" }));
    await expect(new HttpFetcher({ ...options, maxResponseBytes: 100 }).fetch(new URL("https://93.184.216.34/big"))).rejects.toThrow(/larger than the configured limit/);
  });

  it("enforces the byte cap while streaming an undeclared body", async () => {
    installFetch(() => ({ status: 200, body: "y".repeat(500) }));
    await expect(new HttpFetcher({ ...options, maxResponseBytes: 100 }).fetch(new URL("https://93.184.216.34/stream"))).rejects.toThrow(/larger than the configured limit/);
  });

  it("blocks a private-range target before issuing any request", async () => {
    const requests = installFetch(() => ({ body: "should not reach" }));
    await expect(new HttpFetcher(options).fetch(new URL("http://127.0.0.1/x"))).rejects.toThrow(/non-public address/);
    expect(requests).toHaveLength(0);
  });

  it("re-checks SSRF policy on the redirect target", async () => {
    installFetch((url) =>
      url.includes("93.184.216.34")
        ? { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }
        : { status: 200, body: "secret" },
    );
    await expect(new HttpFetcher(options).fetch(new URL("https://93.184.216.34/redirect"))).rejects.toThrow(/non-public address/);
  });
});

describe("removeTrackers", () => {
  it("removes utm_ and mtm_ params and the xtor=RSS fragment", () => {
    expect(removeTrackers("https://example.com/a?utm_source=x&id=7&mtm_campaign=y#xtor=RSS-1")).toBe("https://example.com/a?id=7");
  });

  it("leaves clean URLs untouched", () => {
    expect(removeTrackers("https://example.com/a?id=7")).toBe("https://example.com/a?id=7");
  });

  it("returns the raw string when the URL cannot be parsed", () => {
    expect(removeTrackers("::not a url::")).toBe("::not a url::");
  });
});
