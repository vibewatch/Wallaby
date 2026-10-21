import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

import { e2eEnvironment, e2eRuntimeRoot } from "./environment";

const execute = promisify(execFile);

export default async function globalSetup() {
  await rm(e2eRuntimeRoot, { recursive: true, force: true });
  await mkdir(e2eRuntimeRoot, { recursive: true });
  const env = { ...process.env, ...e2eEnvironment };
  await execute("npx", ["prisma", "migrate", "deploy"], { cwd: process.cwd(), env });
  await execute("npx", ["tsx", "prisma/seed.ts"], { cwd: process.cwd(), env });
  const prisma = new PrismaClient({ datasources: { db: { url: e2eEnvironment.DATABASE_URL } } });
  try {
    await prisma.user.create({
      data: {
        username: "test-reader",
        email: "reader@example.test",
        name: "Test Reader",
        passwordHash: await hash("wallaby-test-password", 12),
        role: "ADMIN",
        preference: { create: {} },
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}
