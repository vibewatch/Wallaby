import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";

import type { NormalizedImportEntry } from "@/lib/importers";

const requestEndpoint = "https://getpocket.com/v3/oauth/request";
const authorizeEndpoint = "https://getpocket.com/v3/oauth/authorize";
const retrieveEndpoint = "https://getpocket.com/v3/get";
const pageSize = 30;
const maximumEntries = 5_000;

type Fetch = typeof fetch;

export type PocketJobOptions = {
  consumerKey: string;
  markAsRead: boolean;
  offset: number;
  remoteComplete: boolean;
};

export type PocketPage = {
  entries: NormalizedImportEntry[];
  nextOffset: number;
  done: boolean;
};

export class PocketClient {
  readonly #consumerKey: string;
  readonly #accessToken?: string;
  readonly #fetch: Fetch;

  constructor(input: { consumerKey: string; accessToken?: string; fetch?: Fetch }) {
    this.#consumerKey = requiredString(input.consumerKey, "Pocket consumer key");
    this.#accessToken = input.accessToken?.trim() || undefined;
    this.#fetch = input.fetch ?? fetch;
  }

  async requestToken(redirectUri: string): Promise<string> {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== "http:" && redirect.protocol !== "https:") throw new Error("Pocket redirect URL must use HTTP or HTTPS");
    const response = await this.#post(requestEndpoint, { consumer_key: this.#consumerKey, redirect_uri: redirect.toString() });
    return requiredString(response.code, "Pocket request token");
  }

  async authorize(requestToken: string): Promise<{ accessToken: string; username?: string }> {
    const response = await this.#post(authorizeEndpoint, {
      consumer_key: this.#consumerKey,
      code: requiredString(requestToken, "Pocket request token"),
    });
    const username = typeof response.username === "string" && response.username.trim() ? response.username.trim() : undefined;
    return { accessToken: requiredString(response.access_token, "Pocket access token"), username };
  }

  async *retrievePages(offset = 0, markAsRead = false): AsyncGenerator<PocketPage> {
    if (!this.#accessToken) throw new Error("Pocket access token is required to retrieve entries");
    if (!Number.isInteger(offset) || offset < 0 || offset > maximumEntries) throw new Error("Pocket import offset is invalid");
    let currentOffset = offset;
    while (currentOffset <= maximumEntries) {
      const count = Math.min(pageSize, maximumEntries - currentOffset);
      if (count === 0) {
        yield { entries: [], nextOffset: currentOffset, done: true };
        return;
      }
      const response = await this.#post(retrieveEndpoint, {
        consumer_key: this.#consumerKey,
        access_token: this.#accessToken,
        detailType: "complete",
        state: "all",
        sort: "newest",
        count,
        offset: currentOffset,
      });
      const records = pocketRecords(response.list);
      const entries = records.flatMap((record) => {
        const normalized = normalizePocketEntry(record, markAsRead);
        return normalized ? [normalized] : [];
      });
      const nextOffset = currentOffset + records.length;
      const done = records.length < count || nextOffset >= maximumEntries;
      yield { entries, nextOffset, done };
      if (done) return;
      currentOffset = nextOffset;
    }
  }

  async #post(endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.#fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Accept": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error(`Pocket returned an unreadable response (${response.status})`); }
    if (!response.ok) {
      const message = response.headers.get("x-error") || response.headers.get("x-error-code") || recordString(payload, "error") || `HTTP ${response.status}`;
      throw new Error(`Pocket request failed: ${message}`);
    }
    if (!isRecord(payload)) throw new Error("Pocket returned an invalid response");
    return payload;
  }
}

export function normalizePocketEntry(record: Record<string, unknown>, markAsRead = false): NormalizedImportEntry | null {
  const url = validHttpUrl(record.resolved_url) ?? validHttpUrl(record.given_url);
  if (!url) return null;
  const resolvedTitle = recordString(record, "resolved_title");
  const givenTitle = recordString(record, "given_title");
  const tags = isRecord(record.tags) ? Object.keys(record.tags).map((tag) => tag.trim()).filter(Boolean).slice(0, 1_000) : [];
  const timeAdded = recordString(record, "time_added");
  const createdAt = timeAdded && /^\d{1,13}$/.test(timeAdded)
    ? new Date(Number(timeAdded) * (timeAdded.length > 10 ? 1 : 1_000))
    : undefined;
  const previewPicture = pocketPreviewPicture(record);
  return {
    url,
    title: resolvedTitle || givenTitle || "Untitled",
    tags,
    archived: markAsRead || String(record.status) === "1",
    starred: String(record.favorite) === "1",
    createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : undefined,
    previewPicture: previewPicture ?? undefined,
    publishedBy: [],
    annotations: [],
  };
}

export function readPocketJobOptions(value: Prisma.JsonValue | null): PocketJobOptions {
  if (!isRecord(value)) throw new Error("Pocket import options are invalid");
  const consumerKey = requiredString(value.consumerKey, "Pocket consumer key");
  const offset = value.offset;
  if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > maximumEntries) throw new Error("Pocket import offset is invalid");
  if (typeof value.markAsRead !== "boolean" || typeof value.remoteComplete !== "boolean") throw new Error("Pocket import options are invalid");
  return { consumerKey, markAsRead: value.markAsRead, offset: Number(offset), remoteComplete: value.remoteComplete };
}

export function isPocketEncryptionConfigured(): boolean {
  try { pocketEncryptionKey(); return true; }
  catch { return false; }
}

export function encryptPocketToken(token: string): string {
  const value = requiredString(token, "Pocket token");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", pocketEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptPocketToken(payload: string): string {
  const [version, encodedIv, encodedTag, encodedCiphertext] = payload.split(":");
  if (version !== "v1" || !encodedIv || !encodedTag || encodedCiphertext === undefined) throw new Error("Unsupported encrypted Pocket token");
  const decipher = createDecipheriv("aes-256-gcm", pocketEncryptionKey(), Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, "base64url")), decipher.final()]).toString("utf8");
}

function pocketEncryptionKey(): Buffer {
  const configured = process.env.POCKET_TOKEN_KEY?.trim();
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("POCKET_TOKEN_KEY must be a base64-encoded 32-byte key");
    return key;
  }
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret || authSecret.length < 16) throw new Error("POCKET_TOKEN_KEY or a strong AUTH_SECRET is required for Pocket token encryption");
  return createHash("sha256").update("wallaby:pocket-token:v1\0").update(authSecret).digest();
}

function pocketRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) return Object.values(value).filter(isRecord);
  throw new Error("Pocket returned an invalid entry list");
}

function pocketPreviewPicture(record: Record<string, unknown>): string | null {
  if (!isRecord(record.images)) return null;
  for (const image of Object.values(record.images)) {
    if (isRecord(image)) {
      const source = validHttpUrl(image.src);
      if (source) return source;
    }
  }
  return null;
}

function validHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

function recordString(record: unknown, key: string): string | null {
  if (!isRecord(record) || typeof record[key] !== "string" || !record[key].trim()) return null;
  return record[key].trim();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
