import { describe, expect, it } from "vitest";

import { type RefetchSummary, startBulkRefetch } from "./bulk-refetch";

function deferredSchedule() {
  const tasks: Array<() => Promise<void>> = [];
  return { tasks, schedule: (task: () => Promise<void>) => { tasks.push(task); } };
}

describe("startBulkRefetch", () => {
  it("reloads every entry with bounded concurrency and summarises the outcome", async () => {
    const { tasks, schedule } = deferredSchedule();
    let active = 0;
    let peak = 0;
    const outcomes: Record<string, "ok" | "partial" | "fail"> = { a: "ok", b: "partial", c: "fail", d: "ok", e: "ok", f: "fail", g: "ok" };
    const reload = async (_userId: string, entryId: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (outcomes[entryId] === "fail") throw new Error("unreachable");
      return { isNotParsed: outcomes[entryId] === "partial" };
    };
    let summary: RefetchSummary | undefined;
    expect(startBulkRefetch("reader-1", Object.keys(outcomes), { schedule, reload, onDone: (result) => { summary = result; } })).toBe(true);
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(summary).toEqual({ fetched: 4, incomplete: 1, failed: 2 });
    expect(peak).toBe(3);
  });

  it("refuses a second batch for the same reader until the first finishes", async () => {
    const { tasks, schedule } = deferredSchedule();
    const reload = async () => ({ isNotParsed: false });
    expect(startBulkRefetch("reader-2", ["a"], { schedule, reload })).toBe(true);
    // Claimed before the first batch has even started.
    expect(startBulkRefetch("reader-2", ["b"], { schedule, reload })).toBe(false);
    expect(startBulkRefetch("reader-3", ["c"], { schedule, reload })).toBe(true);
    await Promise.all(tasks.map((task) => task()));
    expect(startBulkRefetch("reader-2", ["b"], { schedule, reload })).toBe(true);
    await tasks.at(-1)!();
  });

  it("releases the claim when scheduling fails", () => {
    const reload = async () => ({ isNotParsed: false });
    expect(() => startBulkRefetch("reader-4", ["a"], { schedule: () => { throw new Error("outside a request"); }, reload })).toThrow("outside a request");
    expect(startBulkRefetch("reader-4", ["a"], { schedule: () => undefined, reload })).toBe(true);
  });
});
