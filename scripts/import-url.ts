import { findCliUser, importSingleUrl } from "../lib/cli-operations";
import { db } from "../lib/db";
import { cliBoolean, parseCliArgs } from "./cli-args";

const args = parseCliArgs();
const [identifier, url] = args.positionals;

try {
  if (!identifier || !url) throw new Error("Usage: npm run import:url -- <username-or-id> <url> [--tags=one,two] [--mark-as-read] [--use-user-id]");
  const user = await findCliUser(identifier, cliBoolean(args, "use-user-id", "useUserId"));
  const result = await importSingleUrl({ userId: user.id, url, tags: args.options.get("tags"), markAsRead: cliBoolean(args, "mark-as-read", "markAsRead") });
  console.info(JSON.stringify({ user: user.username, entryId: result.entry.id, created: result.created }));
  if (!result.created) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { await db.$disconnect(); }
