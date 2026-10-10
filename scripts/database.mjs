import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const provider = process.env.DATABASE_PROVIDER || (/^postgres(?:ql)?:/.test(process.env.DATABASE_URL || "") ? "postgresql" : "sqlite");
if (!["sqlite", "postgresql"].includes(provider)) throw new Error("DATABASE_PROVIDER must be sqlite or postgresql");
const schema = provider === "postgresql" ? "prisma/postgresql/schema.prisma" : "prisma/schema.prisma";
if (provider === "postgresql") {
  mkdirSync("prisma/postgresql", { recursive: true });
  const generated = readFileSync("prisma/schema.prisma", "utf8").replace('provider = "sqlite"', 'provider = "postgresql"');
  if (!existsSync(schema) || readFileSync(schema, "utf8") !== generated) writeFileSync(schema, generated);
}
const args = process.argv.slice(2);
if (args[0] !== "prepare") {
  const result = spawnSync("node", ["node_modules/prisma/build/index.js", ...args, "--schema", schema], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
