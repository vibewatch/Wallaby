import { db } from "@/lib/db";
import { pruneExpiredRecords } from "@/lib/maintenance";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const counts = await pruneExpiredRecords({ dryRun });
  console.log(JSON.stringify({ dryRun, ...counts }));
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exitCode = 1;
  });
