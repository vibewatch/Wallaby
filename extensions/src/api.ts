import { parseEntryUrl } from "../../lib/entry-url";

export type Connection = { baseUrl: string; token: string };
export type SavedEntry = { id: string; title: string; tags: string[]; archived: boolean; starred: boolean; incomplete: boolean };
export type EntryChanges = { title: string; tags: string[]; archive: boolean; starred: boolean };

export function instanceUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("Enter the full address of your Wallaby instance, including https://."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Use HTTPS for your instance. HTTP is allowed only on localhost for development.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Use an instance address without credentials, a query, or a fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function connectionInput(value: unknown): Connection {
  if (!value || typeof value !== "object" || !("baseUrl" in value) || typeof value.baseUrl !== "string" ||
    !("token" in value) || typeof value.token !== "string") {
    throw new Error("Enter your instance address and API token in extension settings.");
  }
  const token = value.token.trim();
  if (!token || token.length > 4096 || /\s/.test(token)) throw new Error("Enter a valid API token from Wallaby Settings.");
  return { baseUrl: instanceUrl(value.baseUrl), token };
}

export function hostPermission(baseUrl: string): string {
  const url = new URL(instanceUrl(baseUrl));
  // WebExtension host permissions cover every port on the granted hostname.
  return `${url.protocol}//${url.hostname}/*`;
}

export function articleUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) throw new Error("Open a web article first. Browser settings, files, and extension pages cannot be saved.");
  return parseEntryUrl(value).toString();
}

export function tagLabels(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

export function savedEntry(value: unknown): SavedEntry {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" ||
    !("title" in value) || typeof value.title !== "string" || !("tags" in value) || !Array.isArray(value.tags)) {
    throw new Error("Your instance returned an invalid article. Check that this is a supported Wallaby server.");
  }
  return {
    id: value.id,
    title: value.title,
    tags: value.tags.map((tag: unknown) => {
      if (!tag || typeof tag !== "object" || !("label" in tag) || typeof tag.label !== "string") {
        throw new Error("Your instance returned invalid tags.");
      }
      return tag.label;
    }),
    archived: "is_archived" in value && Boolean(value.is_archived),
    starred: "is_starred" in value && Boolean(value.is_starred),
    incomplete: "is_not_parsed" in value && Boolean(value.is_not_parsed),
  };
}

export function readerUrl(baseUrl: string, id: string): string {
  return `${instanceUrl(baseUrl)}/entries/${encodeURIComponent(id)}`;
}

export class WallabyClient {
  constructor(private connection: Connection, private fetcher: typeof fetch = fetch.bind(globalThis)) {}

  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.connection.baseUrl}/api/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.connection.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      throw new Error("Could not reach your instance. Check its address, certificate, and site permission. A timed-out save may have completed; reopen this popup before retrying.");
    }
    if (response.status === 401) throw new Error("Your API token was rejected or revoked. Reconnect in extension settings.");
    if (response.status === 403) throw new Error("Your instance denied access. Check your token and reverse proxy.");
    if (!response.ok) throw new Error(`Your instance returned HTTP ${response.status}. Please retry when it is available.`);
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new Error("Your instance did not return JSON. Check its address and reverse proxy."); }
  }

  async verify(): Promise<void> {
    const result = await this.request("entries?detail=metadata&perPage=1");
    if (!result || typeof result !== "object" || !("_embedded" in result)) throw new Error("This address does not expose the Wallaby API.");
  }

  async find(url: string): Promise<SavedEntry | null> {
    const result = await this.request(`entries/exists?return_id=1&url=${encodeURIComponent(articleUrl(url))}`);
    if (!result || typeof result !== "object" || !("exists" in result)) throw new Error("Your instance returned an invalid saved-article lookup.");
    if (result.exists === null || result.exists === false) return null;
    if (typeof result.exists !== "string") throw new Error("Your instance did not return an article ID.");
    return savedEntry(await this.request(`entries/${encodeURIComponent(result.exists)}?detail=metadata`));
  }

  async tags(): Promise<string[]> {
    const result = await this.request("tags");
    if (!Array.isArray(result)) throw new Error("Your instance returned an invalid tag list.");
    return result.map((tag: unknown) => {
      if (!tag || typeof tag !== "object" || !("label" in tag) || typeof tag.label !== "string") throw new Error("Your instance returned an invalid tag.");
      return tag.label;
    });
  }

  async save(url: string, changes?: EntryChanges, content?: string): Promise<SavedEntry> {
    return savedEntry(await this.request("entries", "POST", { url: articleUrl(url), ...changes, ...(content ? { content } : {}) }));
  }

  async update(id: string, changes: EntryChanges): Promise<SavedEntry> {
    return savedEntry(await this.request(`entries/${encodeURIComponent(id)}`, "PATCH", changes));
  }

  async remove(id: string): Promise<void> {
    await this.request(`entries/${encodeURIComponent(id)}`, "DELETE");
  }
}
