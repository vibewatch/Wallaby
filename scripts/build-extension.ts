import { build } from "esbuild";
import { zipSync, type Zippable } from "fflate";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { extensionManifest } from "../extensions/manifest";

const root = process.cwd();
const output = path.join(root, ".tmp/extensions");
const source = path.join(root, "extensions");

async function archive(directory: string, prefix = ""): Promise<Zippable> {
  const result: Zippable = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await archive(path.join(directory, entry.name), `${name}/`));
    else result[name] = [await readFile(path.join(directory, entry.name)), { mtime: new Date("2024-01-01T00:00:00Z") }];
  }
  return result;
}

async function buildTarget(target: "chrome" | "firefox") {
  const directory = path.join(output, target);
  await rm(directory, { recursive: true, force: true });
  await mkdir(path.join(directory, "icons"), { recursive: true });
  await build({
    entryPoints: ["background", "popup", "options"].map((name) => path.join(source, "src", `${name}.ts`)),
    bundle: true, format: "iife", platform: "browser", target: ["chrome116", "firefox128"],
    outdir: directory, legalComments: "inline", sourcemap: false,
  });
  await build({
    entryPoints: [path.join(source, "src/capture.ts")],
    bundle: true, format: "iife", globalName: "WallabyCapture", platform: "browser",
    target: ["chrome116", "firefox128"], outfile: path.join(directory, "capture.js"), legalComments: "inline",
  });
  for (const file of ["popup.html", "options.html", "privacy.html", "styles.css", "THIRD-PARTY-NOTICES.txt"]) {
    await cp(path.join(source, file), path.join(directory, file));
  }
  await cp(path.join(root, "public/font-licenses.txt"), path.join(directory, "font-licenses.txt"));
  await cp(path.join(root, "node_modules/@mozilla/readability/LICENSE.md"), path.join(directory, "readability-LICENSE.md"));
  // Readability ships a short notice; include the complete Apache 2.0 terms too.
  await cp(path.join(root, "node_modules/typescript/LICENSE.txt"), path.join(directory, "apache-2.0.txt"));
  await cp(path.join(root, "node_modules/@fontsource-variable/mona-sans/files/mona-sans-latin-wght-normal.woff2"), path.join(directory, "mona-sans.woff2"));
  for (const size of [16, 32, 48, 128]) {
    await sharp(path.join(root, "public/icon-512.png")).resize(size, size).png().toFile(path.join(directory, "icons", `${size}.png`));
  }
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(extensionManifest(target), null, 2)}\n`);
  await writeFile(path.join(output, `wallaby-${target}.zip`), zipSync(await archive(directory), { level: 9 }));
  console.log(`Built ${target}: ${path.relative(root, directory)} and .tmp/extensions/wallaby-${target}.zip`);
}

Promise.all([buildTarget("chrome"), buildTarget("firefox")]).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
