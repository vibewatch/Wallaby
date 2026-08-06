import { cleanDuplicateEntries, findCliUser } from "../lib/cli-operations";
import { db } from "../lib/db";
import { parseCliArgs } from "./cli-args";

const args = parseCliArgs();
const [identifier] = args.positionals;

try {
  const user = identifier ? await findCliUser(identifier) : null;
  const result = await cleanDuplicateEntries(user?.id);
  console.info(JSON.stringify({ user: user?.username ?? "all", ...result }));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { await db.$disconnect(); }
