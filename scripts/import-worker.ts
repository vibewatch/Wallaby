import { db } from "../lib/db";
import { runImportWorker } from "../lib/import-queue";
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

async function main(): Promise<void> {
  try {
    const processed = await runImportWorker({ once, signal: controller.signal });
    if (once) console.info(`Processed ${processed} import job${processed === 1 ? "" : "s"}.`);
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
