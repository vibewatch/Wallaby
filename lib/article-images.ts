import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";

import type { Fetcher, FetchResult } from "@wallaby/graby";
import { HttpFetcher } from "@wallaby/graby";
import type { Prisma } from "@prisma/client";
import { JSDOM } from "jsdom";
import sharp from "sharp";

import { db } from "@/lib/db";

const DEFAULT_IMAGE_SETTINGS = {
  imageMaxCount: 30,
  imageMaxBytes: 5_000_000,
  imageEntryMaxBytes: 30_000_000,
  imageUserMaxBytes: 1_000_000_000,
};

const IMAGE_FETCH_CONCURRENCY = 3;
const MAX_INPUT_PIXELS = 40_000_000;

export type ImageCaptureSettings = typeof DEFAULT_IMAGE_SETTINGS & { userBytesAvailable?: number };

export type CapturedEntryImage = {
  id: string;
  userId: string;
  entryId: string;
  originalUrl: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  relativePath: string;
  publicUrl: string;
};

export type CaptureArticleImagesOptions = {
  userId: string;
  entryId: string;
  html: string;
  baseUrl: string;
  previewPicture?: string | null;
  settings?: Partial<ImageCaptureSettings>;
  fetcher?: Fetcher;
  mediaRoot?: string;
};

type DownloadedImage = {
  originalUrl: string;
  contentType: string;
  extension: string;
  bytes: Buffer;
  sha256: string;
};

type SrcsetItem = { source: string; url: string | null; descriptor: string };

export function getMediaRoot(): string {
  return resolve(/* turbopackIgnore: true */ process.env.WALLABY_MEDIA_DIR?.trim() || resolve(process.cwd(), "storage", "media"));
}

export function resolveMediaPath(relativePath: string, mediaRoot = getMediaRoot()): string {
  if (!relativePath || posix.isAbsolute(relativePath) || relativePath.includes("\\")) throw new Error("Invalid media path");
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Invalid media path");
  const root = resolve(mediaRoot);
  const target = resolve(root, ...parts);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error("Invalid media path");
  return target;
}

export async function getImageDownloadConfiguration() {
  return db.instanceConfiguration.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });
}

export async function captureArticleImages(options: CaptureArticleImagesOptions): Promise<{
  html: string;
  previewPicture: string | null;
  images: CapturedEntryImage[];
}> {
  assertStorageSegment(options.userId, "user");
  assertStorageSegment(options.entryId, "entry");
  const settings = { ...DEFAULT_IMAGE_SETTINGS, ...options.settings };
  const mediaRoot = options.mediaRoot ? resolve(options.mediaRoot) : getMediaRoot();
  const fetcher = options.fetcher ?? new HttpFetcher({
    maxRedirects: 5,
    maxResponseBytes: settings.imageMaxBytes,
    requestTimeoutMs: 12_000,
    userAgent: "Wallaby image capture/0.1",
  });

  const dom = new JSDOM(`<body>${options.html}</body>`, { url: options.baseUrl, contentType: "text/html" });
  const document = dom.window.document;
  const singleReferences: { element: Element; attribute: "src" | "poster"; url: string }[] = [];
  const srcsetReferences: { element: Element; items: SrcsetItem[] }[] = [];
  const orderedUrls = new Map<string, number>();
  const register = (value: string | null): string | null => {
    const url = remoteImageUrl(value, options.baseUrl);
    if (url && !orderedUrls.has(url)) orderedUrls.set(url, orderedUrls.size);
    return url;
  };

  for (const element of document.querySelectorAll("img[src]")) {
    const url = register(element.getAttribute("src"));
    if (url) singleReferences.push({ element, attribute: "src", url });
  }
  for (const element of document.querySelectorAll("video[poster]")) {
    const url = register(element.getAttribute("poster"));
    if (url) singleReferences.push({ element, attribute: "poster", url });
  }
  for (const element of document.querySelectorAll("img[srcset], source[srcset]")) {
    const items = parseSrcset(element.getAttribute("srcset") ?? "").map((item) => ({ ...item, url: register(item.source) }));
    if (items.some((item) => item.url)) srcsetReferences.push({ element, items });
  }
  const previewUrl = register(options.previewPicture ?? null);
  const maximumCandidates = Math.min(100, Math.max(settings.imageMaxCount * 2, settings.imageMaxCount));
  const candidates = [...orderedUrls.keys()].slice(0, maximumCandidates);
  const downloads = await mapWithConcurrency(candidates, IMAGE_FETCH_CONCURRENCY, async (url) => {
    try {
      return await downloadImage(url, fetcher, settings.imageMaxBytes);
    } catch {
      return null;
    }
  });

  const accepted = new Map<string, CapturedEntryImage>();
  const written: CapturedEntryImage[] = [];
  const hashes = new Map<string, CapturedEntryImage>();
  let entryBytes = 0;
  let userBytes = 0;
  const userLimit = Math.max(0, settings.userBytesAvailable ?? settings.imageUserMaxBytes);
  try {
    for (const downloaded of downloads) {
      if (!downloaded || accepted.size >= settings.imageMaxCount) continue;
      const duplicate = hashes.get(downloaded.sha256);
      if (duplicate) {
        accepted.set(downloaded.originalUrl, duplicate);
        continue;
      }
      if (entryBytes + downloaded.bytes.length > settings.imageEntryMaxBytes) continue;
      if (userBytes + downloaded.bytes.length > userLimit) continue;
      const image = await persistDownloadedImage(options.userId, options.entryId, downloaded, mediaRoot);
      written.push(image);
      accepted.set(downloaded.originalUrl, image);
      hashes.set(downloaded.sha256, image);
      entryBytes += image.byteSize;
      userBytes += image.byteSize;
    }
  } catch (error) {
    await Promise.allSettled(written.map((image) => unlink(resolveMediaPath(image.relativePath, mediaRoot))));
    throw error;
  }

  let rewritten = 0;
  for (const reference of singleReferences) {
    const image = accepted.get(reference.url);
    if (!image) continue;
    reference.element.setAttribute(reference.attribute, image.publicUrl);
    rewritten += 1;
  }
  for (const reference of srcsetReferences) {
    let changed = false;
    const value = reference.items.map((item) => {
      const image = item.url ? accepted.get(item.url) : null;
      if (image) changed = true;
      return `${image?.publicUrl ?? item.source}${item.descriptor ? ` ${item.descriptor}` : ""}`;
    }).join(", ");
    if (changed) {
      reference.element.setAttribute("srcset", value);
      rewritten += 1;
    }
  }
  const localizedPreview = previewUrl ? accepted.get(previewUrl)?.publicUrl ?? options.previewPicture ?? null : options.previewPicture ?? null;
  return {
    html: rewritten ? document.body.innerHTML : options.html,
    previewPicture: localizedPreview,
    images: written,
  };
}

export async function localizeEntryImages(
  entryId: string,
  overrides: { force?: boolean; fetcher?: Fetcher; mediaRoot?: string; settings?: Partial<ImageCaptureSettings> } = {},
) {
  const entry = await db.entry.findUnique({ where: { id: entryId }, include: { images: true } });
  if (!entry) throw new Error("Entry not found");
  const configuration = await getImageDownloadConfiguration();
  if (!configuration.downloadImagesEnabled && !overrides.force) {
    if (entry.images.length) {
      await db.entryImage.deleteMany({ where: { entryId: entry.id } });
      await removeEntryMediaDirectory(entry.userId, entry.id, overrides.mediaRoot);
    }
    return entry;
  }
  const used = await db.entryImage.aggregate({
    where: { userId: entry.userId, entryId: { not: entry.id } },
    _sum: { byteSize: true },
  });
  const settings: ImageCaptureSettings = {
    imageMaxCount: configuration.imageMaxCount,
    imageMaxBytes: configuration.imageMaxBytes,
    imageEntryMaxBytes: configuration.imageEntryMaxBytes,
    imageUserMaxBytes: configuration.imageUserMaxBytes,
    userBytesAvailable: Math.max(0, configuration.imageUserMaxBytes - (used._sum.byteSize ?? 0)),
    ...overrides.settings,
  };
  const captured = await captureArticleImages({
    userId: entry.userId,
    entryId: entry.id,
    html: entry.content,
    baseUrl: entry.url,
    previewPicture: entry.previewPicture,
    settings,
    fetcher: overrides.fetcher,
    mediaRoot: overrides.mediaRoot,
  });
  try {
    const operations: Prisma.PrismaPromise<unknown>[] = [
      db.entryImage.deleteMany({ where: { entryId: entry.id } }),
    ];
    if (captured.images.length) {
      operations.push(db.entryImage.createMany({ data: captured.images.map((image) => ({
        id: image.id,
        userId: image.userId,
        entryId: image.entryId,
        originalUrl: image.originalUrl,
        contentType: image.contentType,
        byteSize: image.byteSize,
        sha256: image.sha256,
        relativePath: image.relativePath,
      })) }));
    }
    operations.push(db.entry.update({ where: { id: entry.id }, data: { content: captured.html, previewPicture: captured.previewPicture } }));
    await db.$transaction(operations);
  } catch (error) {
    await Promise.allSettled(captured.images.map((image) => unlink(resolveMediaPath(image.relativePath, overrides.mediaRoot))));
    throw error;
  }
  const activePaths = new Set(captured.images.map((image) => image.relativePath));
  await Promise.allSettled(entry.images.filter((image) => !activePaths.has(image.relativePath)).map((image) => unlink(resolveMediaPath(image.relativePath, overrides.mediaRoot))));
  if (!captured.images.length) await removeEntryMediaDirectory(entry.userId, entry.id, overrides.mediaRoot).catch(() => undefined);
  return db.entry.findUniqueOrThrow({ where: { id: entry.id }, include: { tags: true, annotations: true, images: true } });
}

export async function deleteEntriesWithMedia(userId: string, where: Prisma.EntryWhereInput): Promise<number> {
  const entries = await db.entry.findMany({ where: { AND: [{ userId }, where] }, select: { id: true } });
  if (!entries.length) return 0;
  const ids = entries.map((entry) => entry.id);
  const result = await db.entry.deleteMany({ where: { userId, id: { in: ids } } });
  await Promise.allSettled(ids.map((entryId) => removeEntryMediaDirectory(userId, entryId)));
  return result.count;
}

export async function removeEntryMediaDirectory(userId: string, entryId: string, mediaRoot = getMediaRoot()): Promise<void> {
  assertStorageSegment(userId, "user");
  assertStorageSegment(entryId, "entry");
  const directory = resolveMediaPath(posix.join(userId, entryId), mediaRoot);
  await rm(directory, { recursive: true, force: true });
}

export async function removeUserMediaDirectory(userId: string, mediaRoot = getMediaRoot()): Promise<void> {
  assertStorageSegment(userId, "user");
  const directory = resolveMediaPath(userId, mediaRoot);
  await rm(directory, { recursive: true, force: true });
}

export async function readEntryImage(relativePath: string, mediaRoot = getMediaRoot()): Promise<Buffer> {
  const path = resolveMediaPath(relativePath, mediaRoot);
  const details = await stat(path);
  if (!details.isFile() || details.size <= 0) throw new Error("Media file not found");
  return readFile(path);
}

export async function cleanupDownloadedImages({ dryRun = false, mediaRoot = getMediaRoot() } = {}): Promise<{
  tracked: number;
  orphanFiles: number;
  deletedFiles: number;
  missingRecords: number;
}> {
  const root = resolve(/* turbopackIgnore: true */ mediaRoot);
  const records = await db.entryImage.findMany({ select: { id: true, relativePath: true } });
  const tracked = new Map(records.map((record) => [record.relativePath, record.id]));
  const files = await walkMediaFiles(root);
  const fileSet = new Set(files);
  const orphans = files.filter((file) => !tracked.has(file));
  const missingIds = records.filter((record) => !fileSet.has(record.relativePath)).map((record) => record.id);
  if (!dryRun) {
    await Promise.allSettled(orphans.map((file) => unlink(resolveMediaPath(file, root))));
    if (missingIds.length) await db.entryImage.deleteMany({ where: { id: { in: missingIds } } });
    await removeEmptyMediaDirectories(root);
  }
  return { tracked: records.length, orphanFiles: orphans.length, deletedFiles: dryRun ? 0 : orphans.length, missingRecords: missingIds.length };
}

async function downloadImage(url: string, fetcher: Fetcher, maxBytes: number): Promise<DownloadedImage> {
  const response = await fetcher.fetch(new URL(url), { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9" });
  assertSuccessfulImageResponse(response, maxBytes);
  const input = Buffer.from(response.bytes!);
  const detected = detectRasterType(input);
  if (!detected) throw new Error("Unsupported image format");
  const pipeline = sharp(input, { animated: detected.extension === "gif", failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS });
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height || metadata.width > 10_000 || metadata.height > 10_000 || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw new Error("Image dimensions exceed the configured safety limit");
  }
  let encoded: Buffer;
  if (detected.extension === "jpg") encoded = await pipeline.jpeg({ quality: 82, progressive: true }).toBuffer();
  else if (detected.extension === "png") encoded = await pipeline.png({ compressionLevel: 9 }).toBuffer();
  else if (detected.extension === "gif") encoded = await pipeline.gif().toBuffer();
  else if (detected.extension === "webp") encoded = await pipeline.webp({ quality: 82 }).toBuffer();
  else encoded = await pipeline.avif({ quality: 55 }).toBuffer();
  if (!encoded.length || encoded.length > maxBytes) throw new Error("Encoded image exceeds the configured byte limit");
  return {
    originalUrl: url,
    contentType: detected.contentType,
    extension: detected.extension,
    bytes: encoded,
    sha256: createHash("sha256").update(encoded).digest("hex"),
  };
}

function assertSuccessfulImageResponse(response: FetchResult, maxBytes: number): void {
  if (response.status < 200 || response.status >= 300) throw new Error(`Image request returned HTTP ${response.status}`);
  if (!response.bytes?.length) throw new Error("Image response was empty");
  if (response.bytes.length > maxBytes) throw new Error("Image response exceeds the configured byte limit");
}

function detectRasterType(bytes: Uint8Array): { contentType: string; extension: "jpg" | "png" | "gif" | "webp" | "avif" } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { contentType: "image/jpeg", extension: "jpg" };
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { contentType: "image/png", extension: "png" };
  const head = Buffer.from(bytes.subarray(0, 32));
  if (head.subarray(0, 6).toString("ascii") === "GIF87a" || head.subarray(0, 6).toString("ascii") === "GIF89a") return { contentType: "image/gif", extension: "gif" };
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") return { contentType: "image/webp", extension: "webp" };
  if (head.subarray(4, 8).toString("ascii") === "ftyp" && /(?:avif|avis)/.test(head.subarray(8).toString("ascii"))) return { contentType: "image/avif", extension: "avif" };
  return null;
}

async function persistDownloadedImage(userId: string, entryId: string, downloaded: DownloadedImage, mediaRoot: string): Promise<CapturedEntryImage> {
  const id = randomUUID();
  const relativePath = posix.join(userId, entryId, `${id}.${downloaded.extension}`);
  const path = resolveMediaPath(relativePath, mediaRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, downloaded.bytes, { flag: "wx", mode: 0o640 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return {
    id,
    userId,
    entryId,
    originalUrl: downloaded.originalUrl,
    contentType: downloaded.contentType,
    byteSize: downloaded.bytes.length,
    sha256: downloaded.sha256,
    relativePath,
    publicUrl: `/media/${id}`,
  };
}

function remoteImageUrl(value: string | null, baseUrl: string): string | null {
  if (!value || value.startsWith("/media/") || value.startsWith("data:") || value.startsWith("blob:")) return null;
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseSrcset(value: string): SrcsetItem[] {
  return value.split(",").map((candidate) => candidate.trim()).filter(Boolean).map((candidate) => {
    const separator = candidate.search(/\s/);
    return separator < 0
      ? { source: candidate, url: null, descriptor: "" }
      : { source: candidate.slice(0, separator), url: null, descriptor: candidate.slice(separator).trim() };
  });
}

function assertStorageSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${label} storage identifier`);
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, task: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let index = 0;
  async function worker() {
    while (index < values.length) {
      const current = index++;
      output[current] = await task(values[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

async function walkMediaFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative(root, path).split(sep).join("/"));
    }
  }
  await walk(root);
  return files;
}

async function removeEmptyMediaDirectories(root: string): Promise<void> {
  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(resolve(directory, entry.name));
    if (directory !== root) await rmdir(directory).catch(() => undefined);
  }
  await walk(root);
}
