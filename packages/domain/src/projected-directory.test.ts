import { describe, expect, it, vi } from "vitest";
import { collectProjectedDirectory } from "./projected-directory";

describe("bounded canonical directory collection", () => {
  const candidates = Array.from({ length: 250 }, (_, index) => ({ id: String(index).padStart(4, "0"), date: new Date("2026-10-01") }));
  it("hydrates at most 100 canonical bodies and keeps only admitted projections", async () => {
    const load = vi.fn(async (page: typeof candidates) => page.map(row => ({ ...row, body: "x".repeat(65536) })));
    const admit = vi.fn(async (rows: Awaited<ReturnType<typeof load>>) => rows.filter(row => row.id !== "0000"));
    const result = await collectProjectedDirectory({ candidates, load, admit, project: row => ({ id: row.id }) });
    expect(load.mock.calls.map(([page]) => page.length)).toEqual([100, 100, 50]);
    expect(admit.mock.calls.every(([page]) => page.every(row => row.body.length === 65536))).toBe(true);
    expect(result).toHaveLength(249);
    expect(JSON.stringify(result)).not.toContain("body");
  });
  it("rejects incomplete inventories and changed or missing candidate metadata", async () => {
    const run = (inventory: typeof candidates, load = async (rows: typeof candidates) => rows) => collectProjectedDirectory({
      candidates: inventory, load, admit: async rows => rows, project: row => row.id,
    });
    await expect(run(Array.from({ length: 10001 }, (_, i) => ({ id: String(i).padStart(5, "0"), date: new Date() }))))
      .rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
    await expect(run(candidates, async rows => rows.slice(1))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(run(candidates, async rows => rows.map(row => ({ ...row, date: new Date("2025-01-01") }))))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(run([candidates[1], candidates[0]])).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});
