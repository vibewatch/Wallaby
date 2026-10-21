import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

/**
 * Rasterizes the Wallaby mark into the icon set the web app manifest, browsers,
 * and iOS home screens expect. Run with `npm run icons:generate` after changing
 * the artwork below; the PNGs it writes are committed so builds stay offline.
 */

const TERRACOTTA = "#b74e32";
const TERRACOTTA_DEEP = "#973e27";
const PAPER = "#f5f4ed";

/** The open book from the sidebar brand, drawn on a transparent background. */
function glyph(stroke: string, scale: number): string {
  return `<g transform="translate(${256 - 12 * scale} ${256 - 12 * scale}) scale(${scale})" fill="none"
      stroke="${stroke}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </g>`;
}

/** Full-bleed tile: safe for `purpose: maskable`, where the OS crops the edges. */
function maskable(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="${TERRACOTTA}" />
    ${glyph(PAPER, 12)}
  </svg>`;
}

/** Rounded tile with margin, used where the icon is shown as-is. */
function standard(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="112" fill="${TERRACOTTA}" />
    <rect x="8" y="8" width="496" height="496" rx="106" fill="none" stroke="${TERRACOTTA_DEEP}" stroke-width="6" />
    ${glyph(PAPER, 14)}
  </svg>`;
}

/** iOS composites onto black if the icon is transparent, so keep it opaque. */
function apple(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="${TERRACOTTA}" />
    ${glyph(PAPER, 13)}
  </svg>`;
}

const targets = [
  { svg: standard(), size: 192, file: "public/icon-192.png" },
  { svg: standard(), size: 512, file: "public/icon-512.png" },
  { svg: maskable(), size: 192, file: "public/icon-maskable-192.png" },
  { svg: maskable(), size: 512, file: "public/icon-maskable-512.png" },
  { svg: apple(), size: 180, file: "app/apple-icon.png" },
  { svg: standard(), size: 32, file: "app/icon.png" },
];

async function main() {
  await mkdir(path.join(process.cwd(), "public"), { recursive: true });
  for (const { svg, size, file } of targets) {
    const png = await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
    const target = path.join(process.cwd(), file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, png);
    console.log(`wrote ${file} (${size}×${size}, ${png.length} bytes)`);
  }
  // The SVG favicon stays vector so it stays crisp at every tab density.
  await writeFile(path.join(process.cwd(), "app", "icon.svg"), `${standard()}\n`);
  console.log("wrote app/icon.svg");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
