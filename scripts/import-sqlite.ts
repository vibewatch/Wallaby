import { readFile } from "node:fs/promises";

import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

const exportSchema = z.record(z.array(z.record(z.unknown())));
const prisma = new PrismaClient();

async function main() {
  if (!/^postgres(?:ql)?:/.test(process.env.DATABASE_URL || "")) throw new Error("SQLite transfer requires a PostgreSQL destination");
  const filename = process.argv[2];
  if (!filename) throw new Error("Provide the SQLite export filename");
  const tables = exportSchema.parse(JSON.parse(await readFile(filename, "utf8")));
  const models = Prisma.dmmf.datamodel.models;
  for (const model of models) {
    if (!tables[model.name]) throw new Error(`SQLite export is missing ${model.name}`);
  }
  const pending = [...models];
  const ordered: typeof pending = [];
  while (pending.length) {
    const index = pending.findIndex((model) => model.fields.every((field) =>
      !field.relationFromFields?.length || ordered.some((parent) => parent.name === field.type),
    ));
    if (index < 0) throw new Error("Cannot determine a safe foreign-key transfer order");
    ordered.push(...pending.splice(index, 1));
  }
  const counts = await prisma.$transaction(async (transaction) => {
    const counts: Record<string, number> = {};
    for (const model of ordered) {
      const existing = await transaction.$queryRaw<{ count: bigint }[]>(Prisma.sql`SELECT count(*) AS count FROM ${Prisma.raw(`"${model.name}"`)}`);
      if (existing[0].count !== 0n) throw new Error("PostgreSQL destination is not empty; refusing to merge or overwrite data");
    }
    for (const model of ordered) {
      const fields = model.fields.filter((field) => field.kind !== "object");
      for (const row of tables[model.name]) {
        const values = fields.map((field) => {
          const value = row[field.name];
          if (value === undefined) throw new Error(`SQLite export is missing ${model.name}.${field.name}`);
          if (field.type === "Json") return Prisma.sql`CAST(${value === null ? null : typeof value === "string" ? value : JSON.stringify(value)} AS jsonb)`;
          if (field.type === "DateTime" && value !== null) {
            const date = new Date(typeof value === "number" ? value : String(value));
            if (Number.isNaN(date.getTime())) throw new Error(`Invalid date in ${model.name}.${field.name}`);
            return Prisma.sql`${date}`;
          }
          if (field.type === "Boolean") {
            if (value !== 0 && value !== 1 && value !== false && value !== true) throw new Error(`Invalid boolean in ${model.name}.${field.name}`);
            return Prisma.sql`${Boolean(value)}`;
          }
          if (field.kind === "enum") return Prisma.sql`CAST(${value} AS ${Prisma.raw(`"${field.type}"`)})`;
          return Prisma.sql`${value}`;
        });
        await transaction.$executeRaw(Prisma.sql`INSERT INTO ${Prisma.raw(`"${model.name}"`)}
          (${Prisma.join(fields.map((field) => Prisma.raw(`"${field.name}"`)))})
          VALUES (${Prisma.join(values)})`);
      }
      counts[model.name] = tables[model.name].length;
    }
    if (!tables._EntryToTag) throw new Error("SQLite export is missing article/tag relationships");
    for (const row of tables._EntryToTag) {
      if (typeof row.A !== "string" || typeof row.B !== "string") throw new Error("Invalid article/tag relationship");
      await transaction.$executeRaw`INSERT INTO "_EntryToTag" ("A", "B") VALUES (${row.A}, ${row.B})`;
    }
    counts._EntryToTag = tables._EntryToTag.length;
    for (const [name, expected] of Object.entries(counts)) {
      const actual = await transaction.$queryRaw<{ count: bigint }[]>(Prisma.sql`SELECT count(*) AS count FROM ${Prisma.raw(`"${name}"`)}`);
      if (actual[0].count !== BigInt(expected)) throw new Error(`Transfer count mismatch for ${name}`);
    }
    return counts;
  }, { timeout: 600_000, maxWait: 30_000 });
  console.log(JSON.stringify({ event: "database.sqlite_transferred", counts }));
}

void main().catch((error: unknown) => {
  if (error instanceof Error && /^(SQLite|PostgreSQL|Cannot determine|Provide|Invalid (date|boolean|article)|Transfer count)/.test(error.message)) console.error(error.message);
  console.error("SQLite transfer failed; destination transaction was rolled back. Check the export schema and destination availability.");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
