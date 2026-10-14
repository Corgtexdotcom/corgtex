import { beforeEach, describe, expect, it, vi } from "vitest";
const { readableArtifactIds } = vi.hoisted(() => ({ readableArtifactIds: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ readableArtifactIds }));
import { READABLE_ARTIFACT_PAGE_SIZE, scanReadableArtifactPages } from "./readable-artifact-pages";
const actor = { kind: "user", user: { id: "viewer" } } as never;

describe("permission-filtered artifact pages", () => {
  beforeEach(() => vi.resetAllMocks());
  it("counts a complete 5001-row corpus in bounded full-record pages, replenishing hidden rows", async () => {
    const rows = Array.from({ length: 5001 }, (_, index) => ({ id: String(index).padStart(5, "0"),
      workspaceId: "ws", bodyMd: `canonical-${index}`, allowed: index % 3 === 0 }));
    readableArtifactIds.mockImplementation(async (_actor, _ws, _kind, page) => {
      expect(page.length).toBeLessThanOrEqual(READABLE_ARTIFACT_PAGE_SIZE);
      expect(page.every((row: typeof rows[number]) => row.bodyMd === `canonical-${Number(row.id)}`)).toBe(true);
      return new Set(page.filter((row: typeof rows[number]) => row.allowed).map((row: typeof rows[number]) => row.id));
    });
    const visited: string[] = [];
    const loadPage = vi.fn(async (cursor: string | undefined, take: number) => {
      const start = cursor ? Number(cursor) + 1 : 0;
      return rows.slice(start, start + take);
    });
    const count = await scanReadableArtifactPages({ actor, workspaceId: "ws", kind: "BrainArticle", loadPage,
      visit: row => { if (visited.length < 5) visited.push(row.id); } });
    expect(count).toBe(1667);
    expect(visited).toEqual(["00000", "00003", "00006", "00009", "00012"]);
    expect(loadPage).toHaveBeenCalledTimes(51);
  });
  it("checks the final empty page after an exact page boundary, and admits no hidden row", async () => {
    readableArtifactIds.mockResolvedValue(new Set());
    const visit = vi.fn();
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i), title: "restricted" }));
    const loadPage = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    expect(await scanReadableArtifactPages({ actor, workspaceId: "ws", kind: "Meeting", loadPage, visit })).toBe(0);
    expect(loadPage).toHaveBeenLastCalledWith("99", 100);
    expect(visit).not.toHaveBeenCalled();
  });
});
