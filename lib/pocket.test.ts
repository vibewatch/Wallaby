import { afterEach, describe, expect, it } from "vitest";

import { decryptPocketToken, encryptPocketToken, normalizePocketEntry, PocketClient, readPocketJobOptions } from "./pocket";

const originalAuthSecret = process.env.AUTH_SECRET;
const originalPocketTokenKey = process.env.POCKET_TOKEN_KEY;

afterEach(() => {
  process.env.AUTH_SECRET = originalAuthSecret;
  process.env.POCKET_TOKEN_KEY = originalPocketTokenKey;
});

describe("Pocket API client", () => {
  it("exchanges request and authorization tokens using Pocket's JSON contract", async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: HeadersInit | undefined }[] = [];
    const responses = [{ code: "request-code" }, { access_token: "access-code", username: "reader" }];
    const fetchStub: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: init?.headers });
      return Response.json(responses.shift());
    };
    const client = new PocketClient({ consumerKey: "consumer", fetch: fetchStub });

    await expect(client.requestToken("https://wallaby.example/entries/import/pocket/callback")).resolves.toBe("request-code");
    await expect(client.authorize("request-code")).resolves.toEqual({ accessToken: "access-code", username: "reader" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://getpocket.com/v3/oauth/request",
      "https://getpocket.com/v3/oauth/authorize",
    ]);
    expect(calls[0].body).toEqual({ consumer_key: "consumer", redirect_uri: "https://wallaby.example/entries/import/pocket/callback" });
    expect(calls[1].body).toEqual({ consumer_key: "consumer", code: "request-code" });
    expect(calls[0].headers).toMatchObject({ "Content-Type": "application/json; charset=UTF-8", "X-Accept": "application/json" });
  });

  it("retrieves bounded pages and preserves Pocket state, tags, and timestamps", async () => {
    let request = 0;
    const firstPage = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [String(index), {
      resolved_url: `https://example.com/${index}`,
      resolved_title: `Story ${index}`,
      status: "0",
      favorite: index === 0 ? "1" : "0",
      time_added: "1700000000",
      tags: index === 0 ? { Research: {} } : {},
      images: index === 0 ? { 1: { src: "https://images.example/preview.jpg" } } : {},
    }]));
    const fetchStub: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { offset: number };
      expect(body).toMatchObject({ consumer_key: "consumer", access_token: "access", detailType: "complete", state: "all", sort: "newest", count: 30, offset: request ? 30 : 0 });
      request += 1;
      return Response.json({ list: request === 1 ? firstPage : { 30: { given_url: "https://example.com/last", given_title: "Last", status: "1", favorite: "0" } } });
    };
    const pages = [];
    for await (const page of new PocketClient({ consumerKey: "consumer", accessToken: "access", fetch: fetchStub }).retrievePages(0, true)) pages.push(page);

    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ nextOffset: 30, done: false });
    expect(pages[0].entries[0]).toMatchObject({ title: "Story 0", archived: true, starred: true, tags: ["Research"], previewPicture: "https://images.example/preview.jpg" });
    expect(pages[0].entries[0].createdAt?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(pages[1]).toMatchObject({ nextOffset: 31, done: true, entries: [{ title: "Last", archived: true }] });
  });

  it("falls back to the given URL and title while rejecting unusable records", () => {
    expect(normalizePocketEntry({ resolved_url: "javascript:alert(1)", given_url: "https://example.com/given", given_title: "Given", status: "0", favorite: "1" }))
      .toMatchObject({ url: "https://example.com/given", title: "Given", archived: false, starred: true });
    expect(normalizePocketEntry({ given_url: "file:///tmp/nope" })).toBeNull();
  });

  it("encrypts temporary tokens with a domain-separated AUTH_SECRET fallback", () => {
    delete process.env.POCKET_TOKEN_KEY;
    process.env.AUTH_SECRET = "a-strong-test-auth-secret";
    const encrypted = encryptPocketToken("temporary-access-token");
    expect(encrypted).not.toContain("temporary-access-token");
    expect(decryptPocketToken(encrypted)).toBe("temporary-access-token");
  });

  it("strictly validates durable job options", () => {
    expect(readPocketJobOptions({ consumerKey: "key", markAsRead: false, offset: 60, remoteComplete: true }))
      .toEqual({ consumerKey: "key", markAsRead: false, offset: 60, remoteComplete: true });
    expect(() => readPocketJobOptions({ consumerKey: "key", markAsRead: false, offset: -1, remoteComplete: true })).toThrow("offset");
  });

  it("surfaces upstream Pocket errors without leaking request credentials", async () => {
    const fetchStub: typeof fetch = async () => Response.json({ error: "Invalid consumer key" }, { status: 403, headers: { "x-error-code": "152" } });
    const client = new PocketClient({ consumerKey: "secret-consumer", fetch: fetchStub });
    await expect(client.requestToken("https://wallaby.example/callback")).rejects.toThrow("Pocket request failed: 152");
  });
});
