import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { extractPdf } from "../src";

async function buildPdf(configure: (pdf: PDFDocument) => Promise<void> | void): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  await configure(pdf);
  return pdf.save();
}

describe("extractPdf", () => {
  it("extracts text, title, author, and creation date", async () => {
    const bytes = await buildPdf(async (pdf) => {
      pdf.setTitle("A Portable Story");
      pdf.setAuthor("Ada Reader");
      pdf.setCreationDate(new Date("2024-03-02T10:20:30Z"));
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      pdf.addPage().drawText("Readable offline article text.", { x: 50, y: 700, size: 14, font });
    });

    const result = await extractPdf(bytes);
    expect(result.title).toBe("A Portable Story");
    expect(result.authors).toEqual(["Ada Reader"]);
    expect(result.date).toBe("2024-03-02T10:20:30.000Z");
    expect(result.html).toContain("Readable offline article text.");
    expect(result.html).toContain("<pre>");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("splits multiple comma/semicolon-separated authors", async () => {
    const bytes = await buildPdf(async (pdf) => {
      pdf.setAuthor("Ada Reader, Lin Writer");
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      pdf.addPage().drawText("Body.", { x: 50, y: 700, size: 12, font });
    });
    const result = await extractPdf(bytes);
    expect(result.authors).toEqual(["Ada Reader", "Lin Writer"]);
  });

  it("returns empty html for a text-free PDF", async () => {
    const bytes = await buildPdf((pdf) => {
      pdf.addPage(); // blank page, no drawn text
    });
    const result = await extractPdf(bytes);
    expect(result.html).toBe("");
    expect(result.summary).toBe("");
  });

  it("escapes HTML-significant characters in extracted text", async () => {
    const bytes = await buildPdf(async (pdf) => {
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      pdf.addPage().drawText("a < b & c > d", { x: 50, y: 700, size: 12, font });
    });
    const result = await extractPdf(bytes);
    expect(result.html).toContain("&lt;");
    expect(result.html).toContain("&amp;");
    expect(result.html).toContain("&gt;");
    expect(result.html).not.toContain("< b");
  });

  it("rejects a non-PDF byte payload", async () => {
    await expect(extractPdf(new TextEncoder().encode("this is not a pdf"))).rejects.toThrow();
  });
});
