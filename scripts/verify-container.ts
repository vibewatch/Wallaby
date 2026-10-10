import { execFile, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const image = process.env.WALLABY_TEST_IMAGE || `wallaby-production-check:${suffix}`;
const container = `wallaby-production-check-${suffix}`;
const rejectionContainer = `wallaby-production-rejection-check-${suffix}`;
const workerContainer = `wallaby-production-worker-check-${suffix}`;
const continuousWorkerContainer = `wallaby-production-continuous-worker-check-${suffix}`;
const volume = `wallaby-production-check-data-${suffix}`;
const testSecret = "V9yQ2mN8rL4cX6bH1jP5sD3aG0tK7eU9iO2pR8wF6zC4vB1n";
const commonRuntimeEnvironment = [
  "--env", "AUTH_TRUST_HOST=true",
  "--env", "AUTH_URL=http://localhost:3000",
  "--env", "DATABASE_URL=file:/app/storage/wallaby.db",
  "--env", "WALLABY_MEDIA_DIR=/app/storage/media",
  "--env", "WALLABY_BOT_PROFILES=false",
  "--env", "WALLABY_BROWSER_RENDER=false",
];
const runtimeEnvironment = ["--env", `AUTH_SECRET=${testSecret}`, ...commonRuntimeEnvironment];

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execute("docker", args, {
    cwd: repositoryRoot,
    maxBuffer: 20 * 1_024 * 1_024,
  });
  return stdout.trim();
}

async function dockerLogs(name: string): Promise<string> {
  const { stdout, stderr } = await execute("docker", ["logs", name], {
    cwd: repositoryRoot,
    maxBuffer: 20 * 1_024 * 1_024,
  });
  return `${stdout}${stderr}`.trim();
}

async function dockerStreaming(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("docker", args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`docker ${args[0]} exited with ${code ?? signal ?? "an unknown status"}`));
    });
  });
}

async function containerState(): Promise<{ Running: boolean; ExitCode: number; Health?: { Status: string } }> {
  return JSON.parse(await docker(["inspect", "--format", "{{json .State}}", container]));
}

async function waitForReady(origin: string): Promise<{ status: string; checks: { database: string } }> {
  const deadline = Date.now() + 60_000;
  let lastFailure = "the server did not respond";
  while (Date.now() < deadline) {
    const state = await containerState();
    if (!state.Running) throw new Error(`container exited with status ${state.ExitCode}`);
    try {
      const response = await fetch(`${origin}/api/health/ready`, { signal: AbortSignal.timeout(5_000) });
      const body = await response.text();
      lastFailure = `HTTP ${response.status}: ${body}`;
      if (response.ok) {
        const result = JSON.parse(body) as { status: string; checks: { database: string } };
        if (result.status !== "ready" || result.checks.database !== "ok") {
          throw new Error(`unexpected readiness response: ${body}`);
        }
        return result;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(`readiness timed out: ${lastFailure}`);
}

async function waitForDockerHealth(): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const state = await containerState();
    if (!state.Running) throw new Error(`container exited with status ${state.ExitCode}`);
    if (state.Health?.Status === "healthy") return;
    if (state.Health?.Status === "unhealthy") throw new Error("Docker health check reported unhealthy");
    await delay(500);
  }
  throw new Error("Docker health check did not become healthy");
}

function requireHeader(headers: Headers, name: string, expected: string): void {
  const actual = headers.get(name);
  if (!actual?.includes(expected)) throw new Error(`${name} did not include ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`);
}

async function main(): Promise<void> {
  let started = false;
  try {
    if (!process.env.WALLABY_TEST_IMAGE) await dockerStreaming(["build", "--build-arg", "INSTALL_CHROMIUM=false", "--tag", image, "."]);
    const imageBytes = Number(await docker(["image", "inspect", "--format", "{{.Size}}", image]));
    if (imageBytes > 650_000_000) throw new Error(`Production image exceeds the 650 MB Docker-reported size budget: ${imageBytes}`);
    await docker(["run", "--rm", "--entrypoint", "node", image, "-e",
      "const fs=require('node:fs'); for(const path of ['.next/cache','node_modules/@next/swc-linux-x64-gnu','node_modules/@next/swc-linux-x64-musl','node_modules/tsx','node_modules/@esbuild','/usr/local/include/node']) if(fs.existsSync(path)) throw new Error('Build-only artifact in runtime: '+path);"]);
    let rejected = false;
    try {
      await docker([
        "run", "--name", rejectionContainer, "--no-healthcheck",
        "--volume", `${volume}:/app/storage`,
        "--env", "AUTH_SECRET=replace-with-a-long-random-value",
        ...commonRuntimeEnvironment,
        image,
      ]);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("container accepted a placeholder production secret");
    const rejectionLogs = await dockerLogs(rejectionContainer);
    if (!rejectionLogs.includes("AUTH_SECRET") || !rejectionLogs.includes("Invalid production configuration")) {
      throw new Error(`unsafe configuration failed for an unexpected reason: ${rejectionLogs}`);
    }
    const rejectedDatabase = await docker([
      "run", "--rm", "--entrypoint", "node",
      "--volume", `${volume}:/app/storage`,
      image, "-e",
      "process.stdout.write(require('node:fs').existsSync('/app/storage/wallaby.db') ? 'present' : 'absent')",
    ]);
    if (rejectedDatabase !== "absent") throw new Error("unsafe configuration touched the database before rejection");

    await docker([
      "run", "--detach", "--name", container,
      "--publish", "127.0.0.1::3000",
      "--volume", `${volume}:/app/storage`,
      ...runtimeEnvironment,
      image,
    ]);
    started = true;

    const portBinding = await docker(["port", container, "3000/tcp"]);
    const port = portBinding.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) throw new Error(`could not determine published port from ${JSON.stringify(portBinding)}`);
    const origin = `http://127.0.0.1:${port}`;
    const readiness = await waitForReady(origin);
    await waitForDockerHealth();

    const response = await fetch(`${origin}/api/health/live`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`liveness returned HTTP ${response.status}`);
    requireHeader(response.headers, "content-security-policy", "frame-ancestors 'none'");
    requireHeader(response.headers, "x-frame-options", "DENY");
    requireHeader(response.headers, "x-content-type-options", "nosniff");
    requireHeader(response.headers, "cache-control", "no-store");
    if (response.headers.has("x-powered-by")) throw new Error("liveness exposed X-Powered-By");
    if (response.headers.has("set-cookie")) throw new Error("liveness unexpectedly emitted a session cookie");

    const uid = await docker(["exec", container, "id", "-u"]);
    if (uid !== "1001") throw new Error(`container ran as unexpected uid ${JSON.stringify(uid)}`);
    const bootstrap = await docker([
      "exec", "--env", "BOOTSTRAP_ADMIN_PASSWORD=Container-bootstrap-password-1",
      container, "npm", "run", "users:bootstrap",
    ]);
    if (!bootstrap.includes("Administrator created.")) throw new Error("administrator bootstrap did not create the initial account");
    const repeatedBootstrap = await docker([
      "exec", "--env", "BOOTSTRAP_ADMIN_PASSWORD=Container-bootstrap-password-2",
      container, "npm", "run", "users:bootstrap",
    ]);
    if (!repeatedBootstrap.includes("no account was changed")) throw new Error("administrator bootstrap was not idempotent");
    const bootstrapState = await docker([
      "exec", container, "node", "-e",
      "const { PrismaClient } = require('@prisma/client'); const { compare } = require('bcryptjs'); const db = new PrismaClient(); (async () => { const users = await db.user.findMany(); if (users.length !== 1 || users[0].username !== 'admin' || users[0].role !== 'ADMIN' || !await compare('Container-bootstrap-password-1', users[0].passwordHash)) throw new Error('Bootstrap created an unexpected account or changed its password'); console.log('bootstrap-ok'); })().finally(() => db.$disconnect()).catch(() => { process.exitCode = 1; });",
    ]);
    if (bootstrapState !== "bootstrap-ok") throw new Error("administrator credentials did not survive repeated bootstrap");
    const runtimeProof = await docker(["exec", container, "node", "runtime/scripts/runtime-smoke.mjs"]);
    if (!runtimeProof.includes("native-roundtrip")) throw new Error("Native image/PDF runtime proof failed");
    console.log(runtimeProof);
    const runtimeResult: unknown = JSON.parse(runtimeProof.slice(runtimeProof.lastIndexOf("\n") + 1));
    await docker([
      "exec", container, "node", "-e",
      "for (const dependency of ['@playwright/test','eslint','vitest']) { try { require.resolve(dependency); throw new Error(`development dependency present: ${dependency}`); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; } }",
    ]);

    const stopStartedAt = Date.now();
    await docker(["stop", "--timeout", "30", container]);
    const shutdownMs = Date.now() - stopStartedAt;
    const stoppedState = await containerState();
    if (stoppedState.Running) throw new Error("container remained running after its shutdown grace period");

    const workerOutput = await docker([
      "run", "--name", workerContainer, "--no-healthcheck",
      "--volume", `${volume}:/app/storage`,
      ...runtimeEnvironment,
      image, "npm", "run", "import:worker:once",
    ]);
    if (!workerOutput.includes("Processed 0 import jobs.")) {
      throw new Error(`worker smoke check returned unexpected output: ${workerOutput}`);
    }
    await docker([
      "run", "--detach", "--init", "--name", continuousWorkerContainer, "--no-healthcheck",
      "--volume", `${volume}:/app/storage`, ...runtimeEnvironment,
      image, "npm", "run", "import:worker",
    ]);
    let pruned = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await dockerLogs(continuousWorkerContainer)).includes("maintenance.pruned")) { pruned = true; break; }
      await delay(500);
    }
    if (!pruned) throw new Error("Continuous worker did not execute its maintenance cycle");
    await docker(["stop", "--timeout", "10", continuousWorkerContainer]);
    const workerExit = Number(await docker(["inspect", "--format", "{{.State.ExitCode}}", continuousWorkerContainer]));
    if (workerExit === 137) throw new Error("Continuous worker required SIGKILL instead of graceful shutdown");

    console.log(JSON.stringify({
      image: "built",
      dependencies: "production-only",
      unsafeConfiguration: "rejected-before-migration",
      migrations: "applied",
      readiness,
      health: "healthy",
      uid: Number(uid),
      worker: "ready",
      continuousWorker: "pruned-and-stopped",
      administrator: "created-without-demo-account",
      runtime: runtimeResult,
      shutdownMs,
      imageBytes,
    }));
  } catch (error) {
    if (started) {
      try {
        const logs = await dockerLogs(container);
        if (logs) console.error(logs);
      } catch {
        // Preserve the original failure when diagnostics are unavailable.
      }
    }
    throw error;
  } finally {
    const cleanup = [
      ["rm", "--force", continuousWorkerContainer],
      ["rm", "--force", workerContainer],
      ["rm", "--force", rejectionContainer],
      ["rm", "--force", container],
      ["volume", "rm", volume],
    ];
    if (!process.env.WALLABY_TEST_IMAGE) cleanup.push(["image", "rm", image]);
    for (const args of cleanup) {
      try { await docker(args); }
      catch { /* The resource may not have been created yet. */ }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
