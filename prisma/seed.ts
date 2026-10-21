import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  for (const rule of [
    'host = "feedproxy.google.com"',
    'host = "feeds.reuters.com"',
    '_all ~ "https?://www\\.lemonde\\.fr/tiny.*"',
  ]) await prisma.ignoreOriginInstanceRule.upsert({ where: { rule }, update: {}, create: { rule } });
  await prisma.instanceConfiguration.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
