# Minimal production image research

Date: 2026-10-10. The research below informed the locally verified implementation
recorded in the final section. Production deployment is not verified here.

## Recommendation

The largest opportunity is **shipping only the dependencies required by the
web server and worker**, rather than combining Next standalone output with an
almost complete production dependency tree. The next opportunity is moving
Prisma migration and one-off operator tooling into a release-matched tools
image. An Alpine base is a secondary optimization, not the complete solution.

For the smallest maintainable production runtime:

1. Keep one lean image for the web server and continuous import worker.
2. Compile local TypeScript entrypoints during the build and trace their
   external dependencies, merging that closure with Next standalone.
3. Run migrations and one-off tools from a matching tools image before rollout.
   Failed migrations must prevent web and worker startup.
4. Preserve PDF import/export, Unicode fonts, image processing, extraction
   configuration, and persistent storage.
5. Compare Debian slim and Alpine after dependency reduction. Keep the
   browser-enabled variant on a supported glibc platform.
6. Evaluate Rust-free Prisma separately, without coupling an adapter/generator
   change to the first packaging improvement.

This reduces the long-running image, not necessarily the aggregate size of all
deployment artifacts. A numerical minimum is not established until candidate
images pass complete feature acceptance.

## Measured baseline

Measurements used a local linux/amd64 reconstruction of commit `741dde3`,
with `DATABASE_PROVIDER=postgresql` and the default browser-free profile.
Its image configuration ID is
`sha256:d527e47a9c708fc7ae383debf732df36b3861bc765f484afd1c7bfd7d1111c27`.
The private registry pull was unauthorized, so this is **not an identity-verified
copy of the deployed image**. The reconstruction used existing build cache.
No alternative application image was built.

| Image | Uncompressed history-layer bytes | Docker inspect `Size` bytes |
| --- | ---: | ---: |
| Reconstructed Wallaby | 681,422,848 | 895,363,973 |
| Local `node:24-bookworm-slim` | 248,922,112 | 329,757,392 |
| `node:24-alpine`, pulled on the research date | 179,830,784 | 241,470,359 |

**Correction to the previous size headline:** the deployed image's previously
reported 894,767,651 bytes was a Docker-reported size, not an independently
established uncompressed or registry-download size. The reconstructed image
has approximately **681 MB of uncompressed history layers**. Its deployed
counterpart's history-layer total was not measured.

Docker documents that containerd keeps compressed image content alongside
uncompressed layers. Keep storage accounting, uncompressed layer totals,
filesystem allocation, and compressed registry bytes separate. Compressed
registry transfer size was not measured here. [Docker storage accounting][1]

The base-image difference on the history-layer metric is **69,091,328 bytes**,
about 10.1% of the reconstructed application's total. This is not a prediction
of identical savings after an Alpine application rebuild.

History totals were measured by summing the numeric `Size` fields from the
read-only Docker Engine `GET /images/{image}/history` response. Filesystem
measurements used `du -sk` in containers with networking disabled.
[Docker history reference][2]; [Engine API][3]

### What occupies the runtime

| Runtime path/group | Allocated MiB, rounded |
| --- | ---: |
| `/app/node_modules` | 350.2 |
| `/app/.next` | 40.4 |
| `/app/packages` | 8.3 |
| `@prisma` + `prisma` + `.prisma`, inside node_modules | 153.1 |
| `@napi-rs`, inside node_modules | 32.0 |
| `@img`, inside node_modules | 18.4 |
| `effect`, inside node_modules | 18.1 |
| `pdfjs-dist`, inside node_modules | 17.7 |
| `playwright` + `playwright-core`, inside node_modules | 16.0 |

Nested rows are subsets, not additional totals. These figures describe allocated
filesystem space, not guaranteed image savings.

Large individual files include Node itself (126,595,440 bytes), canvas/Skia
(33,393,024), the Prisma schema engine (19,631,784), sharp/libvips (18,699,288),
and two separately located Prisma native query engines (17,547,808 each).
The two esbuild paths are hardlinks to the same inode; they are **not** a
duplicated 10 MB saving.

The global Node package-manager directory occupies about 18.8 MiB. Removing
files inherited from an existing image in a later layer does not remove those
bytes from the parent layers; assemble a clean runtime instead if pursuing
that saving. [Docker layer model][4]

## Ranked changes and constraints

| Priority | Change | Main qualification |
| --- | --- | --- |
| 1 | Trace web, worker, validator, and retained operator entrypoints | Preserve native files, dynamic imports, workspace targets, and assets |
| 2 | Build-time compilation of local TS scripts | Remove tsx only once compiled replacements work |
| 3 | Release-matched migration/operator image | Changes startup and deployment ordering; retain rollback behavior |
| 4 | Compare a browser-free Alpine runtime | Native packages must be installed/generated for musl |
| 5 | Assemble a package-manager-free runtime | Current entrypoint and worker use npm |
| 6 | Evaluate Prisma's Rust-free client | Adapter/generator/pooling change, not just deleting an engine |

### Dependency closure rather than broad deletion

Next standalone emits `server.js` and selected dependencies. It does not
automatically copy `public` or `.next/static`, and independently launched
worker/operator entrypoints need their own tracing. Next tracing includes are
route-based, not a substitute for analyzing arbitrary executable entrypoints.
[Next output guide][5]

The installed Next 16.3.8 guide was consulted at
`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md`.
The baseline staging/runner behavior at commit `741dde3` is in
`Dockerfile:78-112`; do not count
already removed maps, declarations, build caches, or full Next/UI trees as
new savings.

Vercel's NFT API accepts multiple entrypoints and produces a file list.
Compile local scripts first, trace the emitted entrypoints, and merge their
closure with standalone. Keep external packages and explicit runtime assets
where analysis cannot resolve dynamic paths. [Vercel NFT][6]

Do not simply replace tsx with Node's native TypeScript execution: Node's type
stripping ignores tsconfig path aliases, requires explicit relative extensions,
and does not execute TypeScript packages under node_modules. Current workspace
exports and imports require deliberate compilation.
[Node 24 TypeScript][7]; `scripts/import-worker.ts:1-4`;
`packages/extractor/package.json:6-12`

esbuild documents non-analyzable imports; sharp specifically requires
externalization when bundling with esbuild. Start by bundling local code and
tracing external dependencies, not blindly bundling native/dynamic packages.
[esbuild limitations][8]; [sharp bundlers][9]

### Prisma is the largest identifiable dependency group

The measured 153.1 MiB includes required application client files, tooling,
engines, and supporting dependencies: it is **not all removable**. Determine
which files belong only to migration tooling before excluding them.

Prisma documents Rust-free clients as production-ready since 6.16.0.
Version 6.19.3 can use `engineType = "client"` with a version-matched driver
adapter. The v6 guide warns that this path was thoroughly tested with
`prisma-client`, rather than the currently used `prisma-client-js` generator.
It requires changes to constructors, generated output, adapters, and connection
handling. SQLite's adapter also introduces native better-sqlite3.
[Prisma v6 Rust-free guide][10]

This does **not** eliminate Prisma 6.19 migration's schema engine.
The pinned implementation resolves and spawns a schema-engine binary.
[Prisma 6.19.3 migration implementation][11]

Moving `migrate deploy` into a release-matched deployment job follows Prisma's
production workflow, but must replace current entrypoint migration behavior
explicitly. Do not use `db push`, runtime downloads of a latest CLI, or silently
skip migrations. [Prisma production migrations][12];
`docker-entrypoint.sh:5-13`; `docker-compose.vm.yml:3-17,26-38`

### Alpine, native modules, and browser support

Official Node Alpine images use musl, unlike Debian's glibc. Prisma supports
Alpine/musl engines, and sharp publishes musl platform packages. Build/install
native dependencies in the target platform; copying Debian binaries is not
a supported shortcut. Retain OpenSSL, certificates, and required shared
libraries. Do not omit sharp's optional platform packages merely because they
are categorized as optional npm dependencies.
[Official Node images][13]; [Prisma Linux requirements][14];
[sharp installation][9]

Playwright browsers do not officially support Alpine. Keep a Debian
browser-enabled image, or explicitly redesign around an isolated glibc browser
service. A remote browser service is an architectural/security change, not a
base-image substitution. [Playwright Docker][15]

For the optional Debian browser profile, the existing default headless launch
can be evaluated with
`playwright install --with-deps --only-shell chromium`, which avoids downloading
full headed Chromium. This does not improve the current browser-free production
profile, and still requires browser OS libraries.
[Playwright headless shell][16];
`Dockerfile:114-121`; `packages/extractor/src/browser.ts:49-55`

Do not remove Unicode/ICU data, PDF fonts, canvas, or image libraries to achieve
a headline size. A smaller custom Node build creates a maintenance burden and
can affect internationalized behavior. [Node internationalization][17]

## Acceptance before deployment

Use consistent architecture/provider/browser flags and immutable image
identities. Record history-layer totals and compressed registry bytes separately.
Do not add estimates from overlapping groups or hardlinked files.

Compare candidates incrementally: dependency closure first, tooling boundary
second, then base platform and any Prisma adapter change.

Required acceptance includes both provider migration histories, bootstrap and
configuration rejection before writes, authenticated web/API flows, indexed
search, import ownership/concurrency, continuous worker and graceful shutdown,
PDF import/export with Unicode, image handling, extraction assets, retained
operator commands, and real browser rendering for the browser-enabled profile.
Preserve transfer and rollback guarantees. Existing starting points are
`scripts/verify-container.ts`, `scripts/verify-postgresql.ts`, and
`scripts/postgresql-smoke.ts`.

The research phase did not change production or dependencies. The follow-up
implementation is described below; no mathematically minimal size is promised.

## Implemented and proven locally

The implementation retains one feature-complete, browser-free image for both
web and worker, including startup migrations and existing npm operator commands.
It deliberately does not split deployment tooling or change Prisma adapters.
Those remain architectural opportunities, not savings claimed here.

Changes:

- Compile local operator/worker TypeScript with esbuild, including workspace
  sources and aliases; trace emitted JavaScript and external dependencies with
  Next's bundled NFT.
- Merge the operator closure with standalone instead of shipping the full
  production dependency tree. Explicitly preserve Prisma platform engines,
  PDF.js workers/native canvas, extraction configurations, and the export font.
- Build native modules on Alpine and assemble a matching Alpine runtime with
  only Node, npm, certificates, OpenSSL and libstdc++. Exclude Yarn, C headers,
  tsx/esbuild, build caches, maps and declarations.
- Restore missing canvas optional-platform lock entries from npm-generated
  metadata without upgrading any existing locked package. Native sharp/canvas
  loading is checked immediately after `npm ci` during image builds.
- Keep `INSTALL_CHROMIUM=true` as the only browser-selection interface: it
  automatically selects Debian throughout and installs headless shell.
- Add `db:import-sqlite` so deployment and acceptance use a supported npm command
  rather than downloading/running tsx in the runtime.
- Enforce a 650,000,000-byte Docker-reported size budget on both browser-free
  provider profiles.

### Final measured artifacts

| Artifact | Uncompressed history-layer bytes | Docker-reported bytes |
| --- | ---: | ---: |
| Reconstructed previous production profile | 681,422,848 | 895,363,973 |
| `wallaby:minimal-postgresql` | **470,691,840** | **625,007,938** |
| `wallaby:minimal-sqlite` | **470,568,960** | **624,839,759** |

The PostgreSQL reduction is **30.93% on uncompressed layers** and **30.20% on
Docker-reported size**, relative to the reconstructed baseline. Registry
compressed-download bytes remain unmeasured. The runtime dependency allocation
fell from 350.2 MiB to 236.2 MiB; compiled local entrypoints occupy about 0.3 MiB.

Local PostgreSQL image ID:
`sha256:600f28f5366a2d90d4e2ea34a4120119a58e879ae3c82d2f6efd68dfcec4feb9`.

Local SQLite image ID:
`sha256:c0a59d73f6456ed16e8fdf5ce4aab78d2fa348f8c1ca9b24c6037531f25a88eb`.

These are the tested local artifacts, not registry publication digests.
Measurements and acceptance were linux/amd64; arm64 was not tested.

### Reproducible acceptance

```bash
docker build --build-arg DATABASE_PROVIDER=postgresql -t wallaby:minimal-postgresql .
WALLABY_TEST_IMAGE=wallaby:minimal-postgresql npm run test:postgresql
docker build -t wallaby:minimal-sqlite .
WALLABY_TEST_IMAGE=wallaby:minimal-sqlite npm run test:container
npm run lint
npm run typecheck
npm run test -- --maxWorkers=2
npm audit --omit=dev --audit-level=moderate
```

Results: **414 tests passed**, lint/typecheck passed, production audit found zero
vulnerabilities, and both image acceptance commands passed twice on the final
artifacts. The old baseline was also run against the new budget and correctly
rejected at 895,363,973 bytes; the smaller images pass at approximately 625 MB.

Acceptance verifies:

- SQLite configuration rejection before database writes, migrations, readiness,
  security headers, UID 1001, idempotent bootstrap, worker execution, continuous
  maintenance and shutdown without SIGKILL.
- PostgreSQL restricted-role migrations, full SQLite fixture transfer,
  nonempty-destination refusal, transaction rollback, indexed search/ownership,
  one-use authentication, concurrent import claims and throttle counters,
  database backup/restore, authenticated reader/API operations, and workers.
- Real native sharp and canvas round trips, PDF export/parsing/extraction with
  Chinese text retained, EPUB ZIP structure, Intl segmentation, and all 2,037
  extraction configurations.
- Compiled import/export/prune operators and **authenticated HTTP PDF/EPUB
  exports**, not just library calls on the developer dependency tree.

PDF.js emits font-type/`loca` warnings for the current embedded-font export.
The multilingual content, page count and extraction assertions still pass;
this is not a claim of warning-free PDF processing.

The optional browser profile was separately built and executed:

```bash
docker build --build-arg INSTALL_CHROMIUM=true \
  --build-arg DATABASE_PROVIDER=postgresql -t wallaby:minimal-browser .
docker run --rm --network none --entrypoint node wallaby:minimal-browser -e '
(async () => {
  const browser = await require("playwright").chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>Wallaby browser proof</title>");
    if (await page.title() !== "Wallaby browser proof") throw new Error("Bad title");
    if ((await page.screenshot()).length < 100) throw new Error("Bad screenshot");
    console.log({ browser: "headless-rendered", uid: process.getuid() });
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
'
```

Headless rendering, PNG screenshot and native canvas passed at UID 1001.
This optional browser artifact is much larger (2,008,397,483 Docker-reported
bytes) and is intentionally outside the browser-free budget; it is not the
production default. No live production containers were modified for this proof.

## Primary sources

[1]: https://docs.docker.com/engine/storage/containerd/#disk-space-usage
[2]: https://docs.docker.com/reference/cli/docker/image/history/
[3]: https://docs.docker.com/reference/api/engine/
[4]: https://docs.docker.com/build/concepts/dockerfile/
[5]: https://nextjs.org/docs/app/api-reference/config/next-config-js/output
[6]: https://github.com/vercel/nft/blob/main/readme.md
[7]: https://nodejs.org/docs/latest-v24.x/api/typescript.html
[8]: https://esbuild.github.io/api/#non-analyzable-imports
[9]: https://sharp.pixelplumbing.com/install/
[10]: https://www.prisma.io/docs/orm/v6/prisma-client/setup-and-configuration/no-rust-engine
[11]: https://github.com/prisma/prisma/blob/6.19.3/packages/migrate/src/SchemaEngineCLI.ts
[12]: https://www.prisma.io/docs/orm/v6/prisma-migrate/workflows/development-and-production
[13]: https://github.com/nodejs/docker-node/blob/main/README.md#image-variants
[14]: https://www.prisma.io/docs/orm/v6/reference/system-requirements#linux-runtime-dependencies
[15]: https://playwright.dev/docs/docker#alpine
[16]: https://playwright.dev/docs/browsers#chromium-headless-shell
[17]: https://nodejs.org/docs/latest-v24.x/api/intl.html
