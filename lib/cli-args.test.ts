import { describe, expect, it } from "vitest";

import { cliBoolean, parseCliArgs } from "../scripts/cli-args";

describe("operator CLI arguments", () => {
  it("keeps positional values and supports equals, following values, and flags", () => {
    const args = parseCliArgs(["demo", "export.json", "--importer=v2", "--tags", "one,two", "--queue-only"]);
    expect(args.positionals).toEqual(["demo", "export.json"]);
    expect(args.options.get("importer")).toBe("v2");
    expect(args.options.get("tags")).toBe("one,two");
    expect(cliBoolean(args, "queue-only")).toBe(true);
  });

  it("accepts upstream camel-case boolean options and explicit false", () => {
    expect(cliBoolean(parseCliArgs(["--markAsRead=true"]), "mark-as-read", "markAsRead")).toBe(true);
    expect(cliBoolean(parseCliArgs(["--markAsRead=false"]), "mark-as-read", "markAsRead")).toBe(false);
  });
});
