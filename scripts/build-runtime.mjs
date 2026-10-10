import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const require = createRequire(import.meta.url);
// Use the tracer shipped with our pinned Next build, just as standalone does.
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
const root = process.cwd();
const destination = join(root, ".next/runtime");
const compiled = join(root, ".next/operators");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const entryPoints = new Set(["scripts/postgresql-smoke.ts", "scripts/runtime-smoke.ts"]);
for (const [name, command] of Object.entries(manifest.scripts)) {
  if (name.startsWith("test:")) continue;
  const match = /^tsx ((?:scripts|prisma)\/\S+\.ts)(.*)$/.exec(command);
  if (!match) continue;
  entryPoints.add(match[1]);
  manifest.scripts[name] = `node runtime/${match[1].replace(/\.ts$/, ".mjs")}${match[2]}`;
}
manifest.scripts.start = "node server.js";
await rm(destination, { recursive: true, force: true });
await rm(compiled, { recursive: true, force: true });
await build({
  entryPoints: [...entryPoints],
  outbase: ".",
  outdir: compiled,
  outExtension: { ".js": ".mjs" },
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  splitting: true,
  packages: "external",
  banner: { js: "import { createRequire as runtimeCreateRequire } from 'node:module'; const require = runtimeCreateRequire(import.meta.url);" },
  plugins: [{
    name: "workspace-sources",
    setup(builder) {
      builder.onResolve({ filter: /^@wallaby\/extractor(?:\/node)?$/ }, ({ path }) => ({
        path: require.resolve(path),
      }));
    },
  }],
});
const emitted = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else emitted.push(relative(root, path));
  }
}
await collect(compiled);
const { fileList, warnings } = await nodeFileTrace([
  ...emitted,
  "scripts/database.mjs",
  "node_modules/prisma/build/index.js",
  "node_modules/playwright-core/cli.js",
], { base: root, processCwd: root });
for (const warning of warnings) console.warn(`Runtime trace warning: ${warning.message}`);
await cp(".next/standalone", destination, { recursive: true, verbatimSymlinks: true });
for (const file of fileList) {
  if (!file.startsWith("node_modules/") && file !== "scripts/database.mjs") continue;
  const target = join(destination, file);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, file), target, { dereference: false, verbatimSymlinks: true, force: true });
}
await cp(compiled, join(destination, "runtime"), { recursive: true });
await cp("prisma", join(destination, "prisma"), { recursive: true });
await cp("node_modules/.prisma", join(destination, "node_modules/.prisma"), { recursive: true });
// Prisma's CLI discovers both platform engines at runtime, even for migrations.
await cp("node_modules/@prisma/engines", join(destination, "node_modules/@prisma/engines"), { recursive: true });
// PDF.js loads its worker and native canvas dynamically, outside static traces.
await cp("node_modules/pdfjs-dist/legacy/build", join(destination, "node_modules/pdfjs-dist/legacy/build"), { recursive: true });
for (const name of await readdir("node_modules/@napi-rs")) {
  if (name === "canvas" || name.startsWith("canvas-")) {
    await cp(`node_modules/@napi-rs/${name}`, join(destination, `node_modules/@napi-rs/${name}`), { recursive: true });
  }
}
await cp("packages/extractor-site-config/configs", join(destination, "packages/extractor-site-config/configs"), { recursive: true });
const font = "node_modules/@fontsource/unifont/files/unifont-latin-400-normal.woff2";
await mkdir(dirname(join(destination, font)), { recursive: true });
await cp(font, join(destination, font));
await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// Ensure traced symlinks cannot point back into the build-only dependency tree.
async function verifyLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await verifyLinks(path);
    else if (entry.isSymbolicLink()) {
      const link = await readlink(path);
      const resolved = resolve(dirname(path), link);
      if (!resolved.startsWith(`${destination}/`)) throw new Error(`Runtime symlink escapes image: ${path}`);
      // Normalize absolute links to the final runtime tree.
      if (link.startsWith("/")) {
        await rm(path);
        await symlink(relative(dirname(path), resolved), path);
      }
    }
  }
}
await verifyLinks(destination);
console.log(`Runtime assembled from ${fileList.size} traced files and ${entryPoints.size} compiled entrypoints.`);
