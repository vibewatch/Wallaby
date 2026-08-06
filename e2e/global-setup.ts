import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";

import { e2eEnvironment, e2eRuntimeRoot } from "./environment";

const execute = promisify(execFile);

export default async function globalSetup() {
  await rm(e2eRuntimeRoot, { recursive: true, force: true });
  await mkdir(e2eRuntimeRoot, { recursive: true });
  const env = { ...process.env, ...e2eEnvironment };
  await execute("npx", ["prisma", "migrate", "deploy"], { cwd: process.cwd(), env });
  await execute("npx", ["tsx", "prisma/seed.ts"], { cwd: process.cwd(), env });
}
