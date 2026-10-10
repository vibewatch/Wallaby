import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import { renderBinaryExport } from "../lib/binary-exports";
import { db } from "../lib/db";
import { extractPdf } from "../packages/extractor/src/pdf";
import { loadSiteConfigDirectory } from "../packages/extractor/src/node";

async function main() {
  const user = await db.user.findFirstOrThrow();
  const entry = await db.entry.create({ data: {
    userId: user.id,
    title: "Runtime PDF proof",
    content: "<article><p>Portable PDF proof. Caf\u00e9, \u4e2d\u6587, \u65e5\u672c\u8a9e.</p></article>",
    url: "https://runtime-proof.example/article",
    givenUrl: "https://runtime-proof.example/article",
    urlHash: `runtime-proof-${Date.now()}`,
  }, include: { tags: true, annotations: true } });
  try {
    const pdf = await renderBinaryExport([entry], "pdf");
    assert.equal(pdf.contentType, "application/pdf");
    assert.equal((await PDFDocument.load(pdf.body)).getPageCount(), 1);
    const extracted = await extractPdf(pdf.body);
    assert.ok(extracted.html.includes("Portable PDF proof"));
    assert.ok(extracted.html.includes("\u4e2d\u6587"), "PDF font and Unicode extraction must survive packaging");
    const epub = await renderBinaryExport([entry], "epub");
    assert.ok(unzipSync(epub.body)["OEBPS/content.opf"]);
    const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: "#315d50" } }).png().toBuffer();
    assert.equal((await sharp(png).metadata()).width, 3);
    const canvas = createCanvas(3, 2);
    canvas.getContext("2d").fillRect(0, 0, 3, 2);
    assert.ok(canvas.toBuffer("image/png").length > 50);
    const configs = loadSiteConfigDirectory("packages/extractor-site-config/configs");
    assert.ok(Object.keys(configs).length >= 2_000);
    assert.ok(new Intl.Segmenter("zh", { granularity: "word" }).segment("\u4e2d\u6587").containing(0));
    console.log(JSON.stringify({ pdf: "export-and-extract", unicode: "retained", epub: "valid", sharp: "native-roundtrip", canvas: "native-roundtrip", siteConfigs: Object.keys(configs).length }));
  } finally {
    await db.entry.delete({ where: { id: entry.id } });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => db.$disconnect());
