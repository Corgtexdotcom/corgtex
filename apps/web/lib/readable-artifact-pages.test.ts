import { beforeEach, describe, expect, it, vi } from "vitest";
const { capture, finish, observeRead, add, captureInputs } = vi.hoisted(() => ({
  capture: vi.fn(), finish: vi.fn(), observeRead: vi.fn(), add: vi.fn(), captureInputs: vi.fn(),
}));
vi.mock("@corgtex/domain", () => ({
  DigestReadRelease: class { capture = capture; finish = finish; observeRead = observeRead; add = add; },
  captureReadableDigestInputs: captureInputs,
  invariant: (condition: boolean) => { if (!condition) throw Object.assign(new Error("changed"), { code: "SOURCE_CHANGED" }); },
}));
import { READABLE_ARTIFACT_PAGE_SIZE, findLatestReadableArtifact, scanReadableArtifactPages } from "./readable-artifact-pages";
const actor = { kind: "user", user: { id: "viewer" } } as never;

describe("permission-filtered artifact pages", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    finish.mockImplementation(async value => value);
    observeRead.mockImplementation(read => read());
  });
  it("counts a complete 5001-row corpus in bounded canonical pages while retaining only scalar totals and compact display items", async () => {
    const rows = Array.from({ length: 5001 }, (_, index) => ({ id: String(index).padStart(5, "0"),
      workspaceId: "ws", bodyMd: `canonical-${index}`, allowed: index % 3 === 0 }));
    capture.mockImplementation(async (_kind, page) => {
      expect(page.length).toBeLessThanOrEqual(READABLE_ARTIFACT_PAGE_SIZE);
      expect(page.every((row: typeof rows[number]) => row.bodyMd === `canonical-${Number(row.id)}`)).toBe(true);
      return { records: page.filter((row: typeof rows[number]) => row.allowed) };
    });
    const visited: string[] = [];
    const loadPage = vi.fn(async (cursor: string | undefined, take: number) => rows.slice(cursor ? Number(cursor) + 1 : 0, (cursor ? Number(cursor) + 1 : 0) + take));
    const count = await scanReadableArtifactPages({ actor, workspaceId: "ws", kind: "BrainArticle", loadPage,
      visit: row => { if (visited.length < 5) visited.push(row.id); } });
    expect(count).toBe(1667);
    expect(finish).toHaveBeenCalledExactlyOnceWith(1667);
    expect(visited).toEqual(["00000", "00003", "00006", "00009", "00012"]);
    expect(loadPage).toHaveBeenCalledTimes(51);
  });
  it("checks the final empty page after an exact boundary and releases the caller even with no visible rows", async () => {
    capture.mockResolvedValue({ records: [] });
    const visit = vi.fn();
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(3, "0"), title: "restricted" }));
    const loadPage = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    expect(await scanReadableArtifactPages({ actor, workspaceId: "ws", kind: "Meeting", loadPage, visit })).toBe(0);
    expect(loadPage).toHaveBeenLastCalledWith("099", 100);
    expect(visit).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("rejects duplicate visible identities before they inflate counts or visit twice", async () => {
    capture.mockImplementation(async (_kind, records) => ({ records }));
    const visit = vi.fn();
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(3, "0") }));
    const loadPage = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([{ id: "099" }]);
    await expect(scanReadableArtifactPages({ actor, workspaceId: "ws", kind: "Meeting", loadPage, visit })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(visit).toHaveBeenCalledTimes(100);
    expect(finish).not.toHaveBeenCalled();
  });
  it("replenishes latest slots after denied pages and releases the selected original proof", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ id: String(1000 - i).padStart(5, "0"), generatedAt: new Date(2026, 0, 1) }));
    captureInputs.mockImplementation(async ({ records }) => ({ records: records.filter((row: typeof rows[number]) => row.id === "00900"), proofs: new Map([["00900", ["original-proof"]]]) }));
    const loadPage = vi.fn().mockResolvedValueOnce(rows.slice(0, 100)).mockResolvedValueOnce(rows.slice(100));
    expect(await findLatestReadableArtifact({ actor, workspaceId: "ws", kind: "WorkspaceBriefing", loadPage })).toBe(rows[100]);
    expect(add).toHaveBeenCalledExactlyOnceWith(["original-proof"]);
    expect(finish).toHaveBeenCalledExactlyOnceWith(rows[100]);
  });
});
