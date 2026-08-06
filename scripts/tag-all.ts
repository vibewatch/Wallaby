import { db } from "@/lib/db";
import { applyTaggingRulesToAll } from "@/lib/rules";

const identifier = process.argv[2]?.trim();

async function main() {
  if (!identifier) {
    console.error("Usage: npm run tag:all -- <username-or-email>");
    process.exitCode = 1;
    return;
  }
  try {
    const user = await db.user.findFirst({
      where: { OR: [{ username: identifier }, { email: identifier.toLowerCase() }] },
      select: { id: true, username: true },
    });
    if (!user) throw new Error(`No Wallaby user matches “${identifier}”`);
    const processed = await applyTaggingRulesToAll(user.id);
    console.log(JSON.stringify({ user: user.username, processed }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Tagging-rule execution failed");
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void main();
