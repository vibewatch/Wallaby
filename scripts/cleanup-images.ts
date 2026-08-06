import { cleanupDownloadedImages, getMediaRoot } from "@/lib/article-images";
import { db } from "@/lib/db";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = await cleanupDownloadedImages({ dryRun });
  console.log(JSON.stringify({ dryRun, mediaRoot: getMediaRoot(), ...result }));
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exitCode = 1;
  });
