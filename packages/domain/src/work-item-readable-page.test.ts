import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { rankedReadableTensionPage, type WorkItemReadRelease } from "./work-item-readable-page";

vi.mock("@corgtex/shared", () => ({ prisma: {} }));

const actor = { kind: "user", user: { id: "viewer" } } as AppActor;
const row = (index: number) => ({ id: `t-${String(index).padStart(5, "0")}`, title: "Tension",
  priority: 0, createdAt: new Date("2026-10-01") });

function fixture(count: number) {
  const rows = Array.from({ length: count }, (_, index) => row(index));
  const admit = vi.fn(async (_kind: string, page: typeof rows) => page);
  const load = vi.fn(async (afterId?: string) => rows.filter(item => !afterId || item.id > afterId).slice(0, 100));
  const votes = vi.fn(async (page: typeof rows) => new Map(page.map(item => [item.id, 0])));
  return { actor, workspaceId: "workspace", release: { admit } as unknown as WorkItemReadRelease,
    load, votes, take: 0, skip: 0, admit };
}

describe("bounded exact tension ranking", () => {
  it("probes beyond an exact candidate budget before returning a complete total", async () => {
    const params = fixture(10_000);
    await expect(rankedReadableTensionPage(params)).resolves.toEqual({ items: [], total: 10_000 });
    expect(params.load).toHaveBeenCalledTimes(101);
    expect(params.votes).not.toHaveBeenCalled();
  });

  it("fails explicitly rather than returning a truncated total above the candidate budget", async () => {
    const params = fixture(10_001);
    await expect(rankedReadableTensionPage(params)).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
    expect(params.admit).toHaveBeenCalledTimes(100);
    expect(params.votes).not.toHaveBeenCalled();
  });

  it("batches only admitted rows and preserves global vote ordering across deep pagination", async () => {
    const params = fixture(205);
    params.admit.mockImplementation(async (_kind, rows) => rows.filter(item => item.id !== row(204).id));
    params.votes.mockImplementation(async rows => new Map(rows.map(item => [item.id, item.id === row(0).id ? 50 : 0])));
    const result = await rankedReadableTensionPage({ ...params, take: 4, skip: 99 });
    // First is t-00000; then ids 203 down to 1. The hidden 204 never ranks.
    expect(result).toEqual({ total: 204, items: [row(105), row(104), row(103), row(102)] });
    expect(params.votes).toHaveBeenCalledTimes(6);
    expect(params.votes.mock.calls.every(([rows]) => rows.length <= 100 && rows.every(item => item.id !== row(204).id))).toBe(true);
  });
});
