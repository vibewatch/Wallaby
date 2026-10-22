import { describe, expect, it, vi } from "vitest";
import { extensionManifest } from "../extensions/manifest";
import { articleUrl, connectionInput, hostPermission, instanceUrl, readerUrl, savedEntry, tagLabels, WallabyClient } from "../extensions/src/api";

const connection = { baseUrl: "https://reader.example.test", token: "test-only-personal-token" };
const entry = { id: "opaque-id", title: "A real article", tags: [{ label: "Ideas" }], is_starred: 1, is_archived: 0, is_not_parsed: 0 };

describe("extension connection boundaries", () => {
  it("normalizes instance roots and preserves subdirectory deployments", () => {
    expect(instanceUrl(" https://reader.example.test/library/// ")).toBe("https://reader.example.test/library");
    expect(hostPermission("https://reader.example.test:8443/library")).toBe("https://reader.example.test/*");
  });

  it.each([
    "http://reader.example.test", "ftp://reader.example.test", "https://user:pass@reader.example.test",
    "https://reader.example.test?token=secret", "https://reader.example.test/#fragment", "not-a-url",
  ])("refuses unsafe instance address %s", (value) => {
    expect(() => instanceUrl(value)).toThrow();
  });

  it.each(["http://localhost:3330", "http://127.0.0.1:3330", "http://[::1]:3330"])("permits explicit loopback development: %s", (value) => {
    expect(instanceUrl(value)).toBe(value);
  });

  it.each([null, {}, { ...connection, token: "" }, { ...connection, token: "a\nb" }, { ...connection, token: "x".repeat(4097) }])("rejects invalid stored credentials", (value) => {
    expect(() => connectionInput(value)).toThrow();
  });

  it.each(["chrome://settings/", "about:config", "file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.test"])("refuses non-article or credential-bearing URLs: %s", (value) => {
    expect(() => articleUrl(value)).toThrow();
  });

  it("keeps HTTPS article parameters and makes safe reader links", () => {
    expect(articleUrl("https://news.example.test/article?id=42#section")).toBe("https://news.example.test/article?id=42#section");
    expect(readerUrl(connection.baseUrl, "../../other")).toBe("https://reader.example.test/entries/..%2F..%2Fother");
    expect(tagLabels("Ideas, design, Ideas, , design thinking")).toEqual(["Ideas", "design", "design thinking"]);
  });
});

describe("extension API transport", () => {
  it("authenticates only with a bearer token, without cookies or redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(entry));
    const result = await new WallabyClient(connection, fetcher).save("https://news.example.test/story");
    expect(result).toEqual({ id: entry.id, title: entry.title, tags: ["Ideas"], archived: false, starred: true, incomplete: false });
    expect(fetcher).toHaveBeenCalledWith(`${connection.baseUrl}/api/entries`, expect.objectContaining({
      method: "POST", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
      headers: expect.objectContaining({ Authorization: `Bearer ${connection.token}` }),
      body: JSON.stringify({ url: "https://news.example.test/story" }),
    }));
  });

  it("checks existing URLs before loading metadata using opaque IDs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ exists: "opaque/id" })).mockResolvedValueOnce(Response.json(entry));
    expect(await new WallabyClient(connection, fetcher).find("https://news.example.test/story")).toMatchObject({ id: entry.id });
    expect(fetcher.mock.calls[1][0]).toBe(`${connection.baseUrl}/api/entries/opaque%2Fid?detail=metadata`);
  });

  it("does not fetch missing article metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ exists: null }));
    expect(await new WallabyClient(connection, fetcher).find("https://news.example.test/story")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("replaces tags with PATCH and passes both false flags explicitly", async () => {
    const changes = { title: "Updated", tags: [], archive: false, starred: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(entry));
    await new WallabyClient(connection, fetcher).update("opaque-id", changes);
    expect(fetcher).toHaveBeenCalledWith(`${connection.baseUrl}/api/entries/opaque-id`, expect.objectContaining({ method: "PATCH", body: JSON.stringify(changes) }));
  });

  it("handles a successful bodyless delete", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(new WallabyClient(connection, fetcher).remove(entry.id)).resolves.toBeUndefined();
  });

  it("sends captured HTML only when requested", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(entry));
    await new WallabyClient(connection, fetcher).save("https://news.example.test/story", undefined, "<article>Readable text</article>");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ url: "https://news.example.test/story", content: "<article>Readable text</article>" }));
  });

  it.each([401, 403, 429, 500])("reports HTTP %s without exposing raw proxy responses or credentials", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret reverse-proxy configuration", { status }));
    await expect(new WallabyClient(connection, fetcher).tags()).rejects.toThrow(status === 401 ? /token.*rejected/ : status === 403 ? /denied/ : new RegExp(`HTTP ${status}`));
  });

  it("reports network and malformed JSON errors explicitly", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(new Response("<html>not JSON</html>"));
    const client = new WallabyClient(connection, fetcher);
    await expect(client.tags()).rejects.toThrow("Could not reach");
    await expect(client.tags()).rejects.toThrow("did not return JSON");
  });

  it("validates server response shapes and marks incomplete extraction", async () => {
    expect(() => savedEntry({})).toThrow("invalid article");
    expect(() => savedEntry({ ...entry, tags: ["bad"] })).toThrow("invalid tags");
    expect(savedEntry({ ...entry, is_not_parsed: 1 }).incomplete).toBe(true);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ unexpected: true }));
    await expect(new WallabyClient(connection, fetcher).verify()).rejects.toThrow("Wallaby API");
    await expect(new WallabyClient(connection, fetcher).tags()).rejects.toThrow("invalid tag list");
    await expect(new WallabyClient(connection, fetcher).find("https://news.example.test/story")).rejects.toThrow("invalid saved-article lookup");
  });
});

describe("browser-specific Manifest V3 packaging", () => {
  it("uses a worker for Chrome and an event page for Firefox", () => {
    expect(extensionManifest("chrome").background).toEqual({ service_worker: "background.js" });
    expect(extensionManifest("firefox").background).toEqual({ scripts: ["background.js"] });
  });

  it.each(["chrome", "firefox"] as const)("does not request persistent browsing or cookie access in %s", (target) => {
    const manifest = extensionManifest(target);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["activeTab", "storage", "contextMenus", "scripting"]);
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(manifest.content_security_policy.extension_pages).not.toContain("unsafe");
  });
});
