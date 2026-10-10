import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";

const execute = promisify(execFile);
const suffix = `${process.pid}-${Date.now()}`;
const image = process.env.WALLABY_TEST_IMAGE || `wallaby-postgresql-check:${suffix}`;
const network = `wallaby-postgresql-${suffix}`;
const postgres = `wallaby-postgresql-db-${suffix}`;
const web = `wallaby-postgresql-web-${suffix}`;
const volume = `wallaby-postgresql-data-${suffix}`;
const password = "Test-only-transfer-password-123";
const environment = [
  "--env", `DATABASE_URL=postgresql://app_wallaby:database-test-only@${postgres}:5432/app_wallaby`,
  "--env", "AUTH_SECRET=postgresql-container-only-auth-key-at-least-32-characters",
  "--env", "AUTH_TRUST_HOST=true",
  "--env", "AUTH_URL=http://localhost:3000",
];

async function docker(args: string[]) {
  return (await execute("docker", args, { maxBuffer: 20 * 1024 * 1024 })).stdout.trim();
}

async function run(args: string[]) {
  return docker(["run", "--rm", "--network", network, ...environment, "--entrypoint", "npm", image, ...args]);
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "wallaby-postgresql-transfer-"));
  let sqlite: PrismaClient | undefined;
  try {
    if (!process.env.WALLABY_TEST_IMAGE) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("docker", ["build", "--build-arg", "DATABASE_PROVIDER=postgresql", "--tag", image, "."], { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`PostgreSQL image build exited ${code}`)));
      });
    }
    const imageBytes = Number(await docker(["image", "inspect", "--format", "{{.Size}}", image]));
    assert.ok(imageBytes <= 650_000_000, `PostgreSQL image exceeded the 650 MB Docker-reported size budget: ${imageBytes}`);
    await docker(["network", "create", network]);
    await docker(["run", "--detach", "--name", postgres, "--network", network, "--env", "POSTGRES_PASSWORD=database-test-only", "postgres:16-bookworm"]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await docker(["exec", postgres, "pg_isready", "--host", "127.0.0.1", "--username", "postgres"]); ready = true; break; }
      catch { await delay(500); }
    }
    assert.ok(ready, "PostgreSQL did not become ready");
    await docker(["exec", postgres, "psql", "-X", "-U", "postgres", "--set=ON_ERROR_STOP=1", "-c", "CREATE ROLE app_wallaby LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'database-test-only';"]);
    await docker(["exec", postgres, "psql", "-X", "-U", "postgres", "--set=ON_ERROR_STOP=1", "-c", "CREATE DATABASE app_wallaby OWNER app_wallaby;"]);
    await run(["run", "db:migrate"]);
    await run(["run", "db:validate"]);
    const databaseUrl = `file:${join(directory, "source.db")}`;
    await execute("node", ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: databaseUrl } });
    sqlite = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const createdAt = new Date("2026-01-01T12:34:56.789Z");
    const user = await sqlite.user.create({ data: {
      id: "transfer-user", username: "transfer-reader", email: "transfer@example.test", role: "ADMIN", sessionVersion: 7,
      passwordHash: await hash(password, 4), preference: { create: { theme: "dark" } },
      siteCredentials: { create: { host: "publisher.example", encryptedUsername: "preserved-username", encryptedPassword: "preserved-ciphertext" } },
      apiTokens: { create: { name: "Retained API client", tokenHash: "preserved-token-hash" } },
    } });
    await sqlite.entry.create({ data: {
      id: "transfer-entry", userId: user.id, title: "Portable reading", content: "<p>A transferred article</p>",
      url: "https://transfer.example/article", givenUrl: "https://transfer.example/article", urlHash: "transfer",
      publishedBy: ["Transferred Author"], readingProgress: 0.75, createdAt,
      tags: { create: { userId: user.id, label: "Migration", slug: "migration" } },
      annotations: { create: { userId: user.id, quote: "Portable reading", text: "Preserved note", ranges: [{ startOffset: 0, endOffset: 16 }] } },
    } });
    await sqlite.importJob.create({ data: {
      userId: user.id, source: "wallabag", status: "completed", total: 1, imported: 1,
      items: { create: { position: 0, payload: { url: "https://transfer.example/article" }, status: "completed", entryId: "transfer-entry" } },
    } });
    await sqlite.$disconnect();
    await execute("python3", ["scripts/export-sqlite.py", join(directory, "source.db"), join(directory, "transfer.json")]);
    await chmod(directory, 0o755);
    await chmod(join(directory, "transfer.json"), 0o644);
    const transferArgs = ["run", "--rm", "--network", network, ...environment, "--volume", `${directory}:/transfer:ro`, "--entrypoint", "npm", image, "run", "db:import-sqlite", "--", "/transfer/transfer.json"];
    const broken = JSON.parse(await readFile(join(directory, "transfer.json"), "utf8")) as Record<string, unknown>;
    broken._EntryToTag = [{ A: "missing-entry", B: "missing-tag" }];
    await writeFile(join(directory, "broken.json"), JSON.stringify(broken), { mode: 0o644 });
    let rolledBack = false;
    try { await docker([...transferArgs.slice(0, -1), "/transfer/broken.json"]); } catch { rolledBack = true; }
    assert.ok(rolledBack, "Invalid relationships must abort the transfer");
    const transfer = await docker(transferArgs);
    assert.ok(transfer.includes("database.sqlite_transferred"), "Transfer did not confirm completion");
    let refused = false;
    try { await docker(transferArgs); } catch { refused = true; }
    assert.ok(refused, "Transfer must refuse a nonempty destination");
    assert.ok((await docker(["run", "--rm", "--network", network, ...environment, "--entrypoint", "node", image, "runtime/scripts/postgresql-smoke.mjs"])).includes("one-use authentication passed"));
    const runtime = await docker(["run", "--rm", "--network", network, ...environment, "--entrypoint", "node", image, "runtime/scripts/runtime-smoke.mjs"]);
    assert.ok(runtime.includes("native-roundtrip"), "Native image/PDF runtime proof failed");
    console.log(runtime);
    const runtimeResult: unknown = JSON.parse(runtime.slice(runtime.lastIndexOf("\n") + 1));
    assert.ok((await run(["run", "maintenance:prune", "--", "--dry-run"])).includes('"dryRun":true'));
    assert.ok((await run(["run", "export:library", "--", "transfer-reader", "/tmp/operator-export.json"])).includes('"entries":2'));
    await writeFile(join(directory, "operator-import.json"), JSON.stringify([{
      url: "https://operator.example/article", title: "Compiled operator import",
      content: `<article><p>${"Compiled operator content. ".repeat(40)}</p></article>`,
      tags: ["operator"],
    }]), { mode: 0o644 });
    const operatorImport = await docker([
      "run", "--rm", "--network", network, ...environment,
      "--volume", `${directory}:/transfer:ro`, "--entrypoint", "npm", image,
      "run", "import:file", "--", "transfer-reader", "/transfer/operator-import.json", "--importer=v2",
    ]);
    assert.ok(operatorImport.includes('"imported":1'), "Compiled import operator did not save its fixture");
    await docker(["exec", postgres, "pg_dump", "-U", "postgres", "--format=custom", "--no-owner", "--no-acl", "--dbname", "app_wallaby", "--file", "/tmp/prior.dump"]);
    await docker(["exec", postgres, "psql", "-X", "-U", "postgres", "--dbname", "app_wallaby", "--set=ON_ERROR_STOP=1", "-c", 'CREATE TABLE "RollbackProbe" (id INTEGER);']);
    await docker(["exec", postgres, "psql", "-X", "-U", "postgres", "--dbname", "app_wallaby", "--set=ON_ERROR_STOP=1", "-c", "DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION app_wallaby;"]);
    await docker(["exec", postgres, "pg_restore", "-U", "postgres", "--exit-on-error", "--clean", "--if-exists", "--no-owner", "--no-acl", "--role", "app_wallaby", "--dbname", "app_wallaby", "/tmp/prior.dump"]);
    assert.equal(await docker(["exec", postgres, "psql", "-X", "-U", "postgres", "--dbname", "app_wallaby", "-At", "-c", 'SELECT count(*) FROM "Entry" WHERE id = \'transfer-entry\';']), "1");
    assert.equal(await docker(["exec", postgres, "psql", "-X", "-U", "postgres", "--dbname", "app_wallaby", "-At", "-c", "SELECT to_regclass('public.\"RollbackProbe\"') IS NULL;"]), "t", "Rollback must remove new candidate schema objects");
    await docker(["run", "--detach", "--name", web, "--network", network, "--publish", "127.0.0.1::3000", "--volume", `${volume}:/app/storage`, ...environment, image]);
    const port = (await docker(["port", web, "3000/tcp"])).match(/:(\d+)$/)?.[1];
    assert.ok(port);
    const origin = `http://127.0.0.1:${port}`;
    ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await fetch(`${origin}/api/health/ready`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch { /* Startup can precede the HTTP listener. */ }
      await delay(500);
    }
    assert.ok(ready, "PostgreSQL web process did not become ready");
    assert.equal((await fetch(`${origin}/auth/signin`)).status, 200);
    const cookies = new Map<string, string>();
    async function request(path: string, init: RequestInit = {}) {
      const response = await fetch(`${origin}${path}`, { ...init, redirect: "manual", headers: {
        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        ...init.headers,
      } });
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(";", 1)[0];
        const separator = pair.indexOf("=");
        cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      return response;
    }
    assert.equal((await request("/api/entries")).status, 401);
    const { csrfToken } = await (await request("/api/auth/csrf")).json() as { csrfToken: string };
    await request("/api/auth/callback/credentials", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
      body: new URLSearchParams({ csrfToken, username: "transfer-reader", password, callbackUrl: "/entries" }),
    });
    const session = await (await request("/api/auth/session")).json() as { user?: { id: string; role: string } };
    assert.equal(session.user?.id, "transfer-user", "Transferred password must sign in through standalone HTTP auth");
    assert.equal(session.user?.role, "ADMIN");
    assert.equal((await request("/entries")).status, 200);
    assert.equal((await request("/entries/transfer-entry")).status, 200);
    const exportedPdf = await request("/export/pdf?id=transfer-entry");
    assert.equal(exportedPdf.status, 200, "Standalone HTTP PDF export must load its native/runtime assets");
    assert.equal((await PDFDocument.load(await exportedPdf.arrayBuffer())).getPageCount(), 1);
    const exportedEpub = await request("/export/epub?id=transfer-entry");
    assert.equal(exportedEpub.status, 200);
    assert.ok(unzipSync(new Uint8Array(await exportedEpub.arrayBuffer()))["OEBPS/content.opf"]);
    for (const term of ["PORTABLE", "migration"]) {
      const searched = await (await request(`/api/search?term=${term}`)).json() as { _embedded: { items: { id: string }[] } };
      assert.ok(searched._embedded.items.some(({ id }) => id === "transfer-entry"), "PostgreSQL API search must preserve case-insensitive text and tag matches");
    }
    const created = await request("/api/entries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      url: "https://http.example/article", title: "HTTP article", content: `<article><p>${"PostgreSQL API saved content. ".repeat(40)}</p></article>`,
    }) });
    assert.equal(created.status, 201, "PostgreSQL HTTP article save must succeed");
    const saved = await created.json() as { id: string; content: string };
    assert.ok(saved.content.includes("PostgreSQL API saved content"));
    assert.equal((await request(`/api/entries/${saved.id}`, { method: "DELETE" })).status, 204);
    const worker = await docker(["run", "--rm", "--network", network, ...environment, "--volume", `${volume}:/app/storage`, image, "npm", "run", "import:worker:once"]);
    assert.ok(worker.includes("Processed 0 import jobs."), "PostgreSQL worker did not complete its smoke");
    console.log(JSON.stringify({ provider: "postgresql", migrations: "applied", transfer: "verified", rollback: "restored", search: "GIN indexed", web: "ready", worker: "ready", operators: "import-export-prune", httpExports: "pdf-and-epub", runtime: runtimeResult, imageBytes }));
  } finally {
    await sqlite?.$disconnect();
    const cleanup = [["rm", "--force", web], ["rm", "--force", "--volumes", postgres], ["volume", "rm", volume], ["network", "rm", network]];
    if (!process.env.WALLABY_TEST_IMAGE) cleanup.push(["image", "rm", image]);
    for (const args of cleanup) {
      try { await docker(args); } catch { /* A failed setup may not create every isolated resource. */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "PostgreSQL acceptance failed");
  process.exitCode = 1;
});
