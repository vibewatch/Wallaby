import { db } from "../lib/db";
import { runImportWorker } from "../lib/import-queue";
import { pruneExpiredRecords } from "../lib/maintenance";
import { validateProductionEnvironment } from "../lib/production-config";

if (process.env.NODE_ENV === "production") {
  const { warnings } = validateProductionEnvironment();
  for (const warning of warnings) console.warn(JSON.stringify({ level: "warn", event: "configuration.warning", message: warning }));
}

const once = process.argv.includes("--once");
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}

const pruneIntervalMs = 60 * 60 * 1_000;

/** A continuous worker also clears expired credentials and old import payloads. */
async function prune(): Promise<void> {
  try {
    const counts = await pruneExpiredRecords();
    console.info(JSON.stringify({ level: "info", event: "maintenance.pruned", service: "wallaby", ...counts, timestamp: new Date().toISOString() }));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "maintenance.prune_failed", service: "wallaby", errorType: error instanceof Error ? error.name : "UnknownError", timestamp: new Date().toISOString() }));
  }
}

async function main(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  if (!once) {
    void prune();
    timer = setInterval(() => void prune(), pruneIntervalMs);
    timer.unref();
  }
  try {
    const processed = await runImportWorker({ once, signal: controller.signal });
    if (once) console.info(`Processed ${processed} import job${processed === 1 ? "" : "s"}.`);
  } finally {
    clearInterval(timer);
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
