import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { exportLibrary, findCliUser } from "../lib/cli-operations";
import { db } from "../lib/db";
import { parseCliArgs } from "./cli-args";

const args = parseCliArgs();
const [identifier, requestedPath] = args.positionals;

try {
  if (!identifier) throw new Error("Usage: npm run export:library -- <username-or-email> [filepath]");
  const user = await findCliUser(identifier);
  const filepath = resolve(requestedPath ?? `${user.username}-export.json`);
  const output = await exportLibrary(user.id);
  await writeFile(filepath, output, { encoding: "utf8", flag: args.flags.has("force") ? "w" : "wx" });
  console.info(JSON.stringify({ user: user.username, entries: JSON.parse(output).length, filepath }));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { await db.$disconnect(); }
