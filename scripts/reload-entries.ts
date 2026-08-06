import { findCliUser, reloadLibraries } from "../lib/cli-operations";
import { db } from "../lib/db";
import { cliBoolean, parseCliArgs } from "./cli-args";

const args = parseCliArgs();
const [identifier] = args.positionals;

try {
  if (!cliBoolean(args, "yes")) throw new Error("Reloading fetches every selected URL. Re-run with --yes to confirm.");
  const user = identifier ? await findCliUser(identifier) : null;
  const result = await reloadLibraries({ userId: user?.id, onlyNotParsed: cliBoolean(args, "only-not-parsed", "onlyNotParsed") });
  console.info(JSON.stringify({ user: user?.username ?? "all", ...result }));
  if (result.failed) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { await db.$disconnect(); }
