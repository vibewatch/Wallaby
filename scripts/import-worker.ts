import { db } from "../lib/db";
import { runImportWorker } from "../lib/import-queue";

const once = process.argv.includes("--once");
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}

try {
  const processed = await runImportWorker({ once, signal: controller.signal });
  if (once) console.info(`Processed ${processed} import job${processed === 1 ? "" : "s"}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
