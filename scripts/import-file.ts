import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { cliImporterSource, findCliUser, importLibrary } from "../lib/cli-operations";
import { db } from "../lib/db";
import { cliBoolean, parseCliArgs } from "./cli-args";

const args = parseCliArgs();
const [identifier, filepath] = args.positionals;

try {
  if (!identifier || !filepath) throw new Error("Usage: npm run import:file -- <username-or-id> <filepath> [--importer=v2] [--mark-as-read] [--use-user-id] [--disable-content-update] [--queue-only]");
  const user = await findCliUser(identifier, cliBoolean(args, "use-user-id", "useUserId"));
  const result = await importLibrary({
    userId: user.id,
    source: cliImporterSource(args.options.get("importer") ?? "auto"),
    filename: basename(filepath),
    contents: await readFile(filepath, "utf8"),
    markAsRead: cliBoolean(args, "mark-as-read", "markAsRead"),
    disableContentUpdate: cliBoolean(args, "disable-content-update", "disableContentUpdate"),
    queueOnly: cliBoolean(args, "queue-only", "queueOnly"),
  });
  console.info(JSON.stringify({ user: user.username, ...result }));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { await db.$disconnect(); }
