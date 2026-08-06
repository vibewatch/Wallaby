import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Fetcher } from "@wallaby/extractor";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { captureArticleImages, resolveMediaPath } from "./article-images";

let redPng: Buffer;
let bluePng: Buffer;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  redPng = await sharp({ create: { width: 3, height: 2, channels: 4, background: "#d13c30" } }).png().toBuffer();
  bluePng = await sharp({ create: { width: 2, height: 3, channels: 4, background: "#2452ad" } }).png().toBuffer();
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("article image capture", () => {
  it("re-encodes, deduplicates, stores, and rewrites article image references", async () => {
    const mediaRoot = await temporaryMediaRoot();
    const dangerousSuffix = Buffer.from("<script>not image data</script>");
    const fetcher = imageFetcher(new Map([
      ["https://cdn.example/hero.png", Buffer.concat([redPng, dangerousSuffix])],
      ["https://cdn.example/poster.png", Buffer.concat([redPng, dangerousSuffix])],
      ["https://cdn.example/alternate.png", bluePng],
    ]));
    const result = await captureArticleImages({
      userId: "user_test",
      entryId: "entry_test",
      baseUrl: "https://article.example/story",
      html: '<picture><source srcset="https://cdn.example/hero.png 1x, https://cdn.example/alternate.png 2x"><img src="https://cdn.example/hero.png" srcset="https://cdn.example/hero.png 320w, https://cdn.example/alternate.png 640w" alt="Story"></picture><video poster="https://cdn.example/poster.png"></video>',
      previewPicture: "https://cdn.example/alternate.png",
      fetcher,
      mediaRoot,
    });

    expect(result.images).toHaveLength(2);
    expect(result.html).not.toContain("https://cdn.example/");
    expect(result.html).toMatch(/src="\/media\/[0-9a-f-]+"/);
    expect(result.html).toMatch(/srcset="\/media\/[0-9a-f-]+ 1x, \/media\/[0-9a-f-]+ 2x"/);
    expect(result.html).toMatch(/poster="\/media\/[0-9a-f-]+"/);
    expect(result.previewPicture).toMatch(/^\/media\/[0-9a-f-]+$/);
    for (const image of result.images) {
      const bytes = await readFile(resolveMediaPath(image.relativePath, mediaRoot));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(bytes.includes(dangerousSuffix)).toBe(false);
      expect(image.contentType).toBe("image/png");
      expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("leaves unsupported or invalid remote content untouched", async () => {
    const mediaRoot = await temporaryMediaRoot();
    const html = '<p><img src="https://cdn.example/vector.svg" alt="Remote"></p>';
    const result = await captureArticleImages({
      userId: "user_test",
      entryId: "entry_test",
      baseUrl: "https://article.example/story",
      html,
      previewPicture: "https://cdn.example/vector.svg",
      fetcher: imageFetcher(new Map([["https://cdn.example/vector.svg", Buffer.from('<svg onload="alert(1)"></svg>')]]), "image/svg+xml"),
      mediaRoot,
    });

    expect(result.images).toHaveLength(0);
    expect(result.html).toBe(html);
    expect(result.previewPicture).toBe("https://cdn.example/vector.svg");
  });

  it("enforces image-count and user-byte quotas without breaking remote fallbacks", async () => {
    const mediaRoot = await temporaryMediaRoot();
    const result = await captureArticleImages({
      userId: "user_test",
      entryId: "entry_test",
      baseUrl: "https://article.example/story",
      html: '<img src="https://cdn.example/one.png"><img src="https://cdn.example/two.png">',
      fetcher: imageFetcher(new Map([
        ["https://cdn.example/one.png", redPng],
        ["https://cdn.example/two.png", bluePng],
      ])),
      settings: { imageMaxCount: 1, userBytesAvailable: 1_000_000 },
      mediaRoot,
    });

    expect(result.images).toHaveLength(1);
    expect(result.html).toContain(result.images[0].publicUrl);
    expect(result.html).toContain("https://cdn.example/two.png");
  });

  it("rejects storage paths that could escape the configured media root", () => {
    expect(() => resolveMediaPath("../secrets", "/tmp/wallaby-media-test")).toThrow("Invalid media path");
    expect(() => resolveMediaPath("user/../../secrets", "/tmp/wallaby-media-test")).toThrow("Invalid media path");
    expect(() => resolveMediaPath("/absolute/path", "/tmp/wallaby-media-test")).toThrow("Invalid media path");
  });
});

async function temporaryMediaRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wallaby-images-"));
  temporaryDirectories.push(directory);
  return directory;
}

function imageFetcher(images: Map<string, Buffer>, mimeType = "image/png"): Fetcher {
  return {
    async fetch(url) {
      const bytes = images.get(url.toString());
      if (!bytes) throw new Error(`Unexpected image URL ${url.toString()}`);
      return {
        body: "",
        bytes,
        url: url.toString(),
        status: 200,
        headers: { "content-type": mimeType },
        mimeType,
      };
    },
  };
}
