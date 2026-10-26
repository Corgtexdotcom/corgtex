import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { readableWorkItemPage, rankedReadableTensionPage, WorkItemReadRelease } from "./work-item-readable-page";

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


describe.each(["Action", "Proposal", "Tension"] as const)("bounded exact %s listing", kind => {
  function pageFixture(count: number, visible: (candidate: ReturnType<typeof row>) => boolean = () => true) {
    const rows = Array.from({length: count}, (_, index) => row(index));
    const admitted = vi.fn(async (_kind: string, page: typeof rows) => page.filter(visible));
    const readable = vi.fn(async (_kind: string, page: typeof rows) => new Set(page.filter(visible).map(item => item.id)));
    const observe = vi.fn(async (_kind: string, _page: typeof rows) => {});
    const load = vi.fn(async (after?: ReturnType<typeof row>) => rows.filter(item => !after || item.id > after.id).slice(0, 100));
    const admission = vi.fn(async () => true);
    return {actor, workspaceId: "workspace", kind, take: 1, skip: 0, load,
      release: {admit: admitted, readable, observe} as unknown as WorkItemReadRelease,
      ...(kind === "Proposal" ? {admit: admission} : {}), admitted, readable, observe, admission};
  }

  it.each([0, 1])("returns the exact 10,000-readable total with take %i and a deep visible skip", async take => {
    const params = pageFixture(10_000);
    expect(await readableWorkItemPage({...params, take, skip: 9_999})).toEqual({total: 10_000, items: take ? [row(9_999)] : []});
    expect(params.load).toHaveBeenCalledTimes(101);
    expect(params.load.mock.calls.at(-1)?.[0]).toEqual(row(9_999));
  });

  it("replenishes hidden candidates beyond 5,001 while keeping the exact readable offset", async () => {
    const params = pageFixture(10_000, item => item.id >= row(5_001).id);
    expect(await readableWorkItemPage({...params, skip: 4_998})).toEqual({total: 4_999, items: [row(9_999)]});
    expect(params.load).toHaveBeenCalledTimes(101);
  });

  it.each([true, false])("rejects 10,001 raw candidates when readable is %s instead of releasing a partial page", async visible => {
    const params = pageFixture(10_001, () => visible);
    await expect(readableWorkItemPage(params)).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
    expect(params.load).toHaveBeenCalledTimes(101);
    // The sentinel never enters permission/proof admission, even if the first
    // readable row already filled the requested response page.
    expect((kind === "Proposal" ? params.readable : params.admitted).mock.calls).toHaveLength(100);
    expect(params.admission.mock.calls.length).toBe(kind === "Proposal" && visible ? 10_000 : 0);
  });

  it("rejects an overflowing zero-take count even when all candidates are hidden", async () => {
    const params = pageFixture(10_001, () => false);
    await expect(readableWorkItemPage({...params, take: 0})).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
    expect(params.load).toHaveBeenCalledTimes(101);
  });
});


describe("bounded related work item existence", () => {
  function relatedFixture(count: number, visibleId?: string) {
    const rows = Array.from({length: count}, (_, index) => row(index));
    const release = new WorkItemReadRelease(actor, "workspace");
    const readable = vi.spyOn(release, "readable").mockImplementation(async (_kind, candidates) =>
      new Set(candidates.filter(candidate => candidate.id === visibleId).map(candidate => candidate.id)));
    const observe = vi.spyOn(release, "observe").mockResolvedValue(undefined);
    const load = vi.fn(async (after: string | undefined, take: number) => rows.filter(item => !after || item.id > after).slice(0, take));
    return {release, readable, observe, load};
  }

  it("proves an exact-limit negative with an empty continuation probe", async () => {
    const f = relatedFixture(10_000);
    expect(await f.release.has("Action", f.load)).toBe(false);
    expect(f.load).toHaveBeenCalledTimes(101); expect(f.observe).not.toHaveBeenCalled();
  });

  it("retains the original late positive at the limit after 9,999 hidden candidates", async () => {
    const last = row(9_999), f = relatedFixture(10_000, last.id);
    expect(await f.release.has("Tension", f.load)).toBe(true);
    expect(f.load).toHaveBeenCalledTimes(100);
    expect(f.observe).toHaveBeenCalledExactlyOnceWith("Tension", [last]);
  });

  it.each([false, true])("rejects an incomplete negative when only the overflow row is readable: %s", async sentinelVisible => {
    const f = relatedFixture(10_001, sentinelVisible ? row(10_000).id : undefined);
    await expect(f.release.has("Action", f.load)).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
    expect(f.load).toHaveBeenCalledTimes(101); expect(f.readable).toHaveBeenCalledTimes(100);
    expect(f.observe).not.toHaveBeenCalled();
  });

  it("returns a proven early positive without requiring full-corpus exhaustion", async () => {
    const first = row(0), f = relatedFixture(10_001, first.id);
    expect(await f.release.has("Action", f.load)).toBe(true);
    expect(f.load).toHaveBeenCalledExactlyOnceWith(undefined, 100);
    expect(f.observe).toHaveBeenCalledExactlyOnceWith("Action", [first]);
  });
});
