import { hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || "admin";
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(username)) {
    throw new Error("BOOTSTRAP_ADMIN_USERNAME must be a valid 3-50 character username");
  }
  if (!password || password.length < 16 || Buffer.byteLength(password) > 72) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD must contain at least 16 characters and at most 72 UTF-8 bytes");
  }
  const passwordHash = await hash(password, 12);
  const created = await prisma.$transaction(async (transaction) => {
    if (await transaction.user.count({ where: { role: "ADMIN" } })) return false;
    if (await transaction.user.findUnique({ where: { username } })) {
      throw new Error("The bootstrap username belongs to an existing account; it was not modified");
    }
    await transaction.user.create({
      data: { username, name: "Administrator", passwordHash, role: "ADMIN", preference: { create: {} } },
    });
    await transaction.instanceConfiguration.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
    return true;
  });
  console.log(created ? "Administrator created." : "An administrator already exists; no account was changed.");
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error && (error.message.startsWith("BOOTSTRAP_") || error.message.startsWith("The bootstrap"))
      ? error.message
      : "Administrator bootstrap failed; inspect database availability and migrations.");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
