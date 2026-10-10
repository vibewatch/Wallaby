import { afterEach, describe, expect, it } from "vitest";

import { containsText, databaseProvider } from "./database-provider";

const original = process.env.DATABASE_URL;
afterEach(() => {
  if (original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original;
});

describe("provider-aware text filters", () => {
  it("keeps SQLite filters compatible and adds PostgreSQL case folding", () => {
    process.env.DATABASE_URL = "file:/tmp/test.db";
    expect(databaseProvider()).toBe("sqlite");
    expect(containsText("Reader")).toEqual({ contains: "Reader" });
    process.env.DATABASE_URL = "postgresql://user:password@db/database";
    expect(databaseProvider()).toBe("postgresql");
    expect(containsText("Reader")).toEqual({ contains: "Reader", mode: "insensitive" });
  });
});
