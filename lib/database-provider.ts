export function databaseProvider(): "postgresql" | "sqlite" {
  return /^postgres(?:ql)?:/.test(process.env.DATABASE_URL || "") ? "postgresql" : "sqlite";
}

export function containsText(contains: string): { contains: string; mode?: "insensitive" } {
  return databaseProvider() === "postgresql" ? { contains, mode: "insensitive" } : { contains };
}
