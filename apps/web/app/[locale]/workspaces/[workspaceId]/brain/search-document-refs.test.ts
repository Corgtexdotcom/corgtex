import { beforeEach, expect, it, vi } from "vitest";
const directory = vi.hoisted(() => vi.fn());
vi.mock("@corgtex/domain", () => ({ listDocumentDirectory: directory }));
import { listLinkableBrainSearchDocumentRefs } from "./search-document-refs";
import { groupBrainSearchResults } from "./view-model";
beforeEach(() => directory.mockReset());
it("resolves readable search sources beyond the displayed page/range without admitting denied sources", async () => {
  const actor = { kind: "user", user: { id: "synthetic" } } as any;
  directory.mockResolvedValue({ items: [{ id: "older-than-directory-window" }], complete: true, nextCursor: null });
  const results = ["older-than-directory-window", "denied-source"].map(sourceId => ({ sourceId, sourceType: "DOCUMENT", chunkId: sourceId, chunkIndex: 0, title: "Synthetic", snippet: "passage", articleSlug: null, meetingId: null }));
  const refs = await listLinkableBrainSearchDocumentRefs({ actor, workspaceId: "workspace", results });
  expect(directory).toHaveBeenCalledWith(actor, "workspace", { ids: ["older-than-directory-window", "denied-source"] });
  const grouped = groupBrainSearchResults(results, new Set(refs.map(row => row.id)));
  expect(grouped.groups.map(group => group.sourceId)).toEqual(["older-than-directory-window"]);
  expect(grouped.hasUnavailableSources).toBe(true);
});
it("does not enumerate documents when search has no document sources", async () => {
  expect(await listLinkableBrainSearchDocumentRefs({ actor: {} as any, workspaceId: "workspace", results: [] })).toEqual([]);
  expect(directory).not.toHaveBeenCalled();
});
