import { rm } from "node:fs/promises";

import { e2eRuntimeRoot } from "./environment";

export default async function globalTeardown() {
  await rm(e2eRuntimeRoot, { recursive: true, force: true });
}
