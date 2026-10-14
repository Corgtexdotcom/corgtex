import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { captureProof } = vi.hoisted(() => ({ captureProof: vi.fn() }));
vi.mock("@corgtex/domain", () => ({
  captureArtifactInputProof: captureProof,
  meetingTranscriptInputProjection: ({ id, workspaceId, title, transcript, createdAt }: Record<string, unknown>) => ({ id, workspaceId, title, transcript, createdAt }),
}));
import { deriveDispatchNotifications } from "./derive-notifications";

const workspaceId = "workspace-1";
function fixture() {
  const row = { id: "subject-1", workspaceId, title: "Current permitted title", bodyMd: "Current body", transcript: "Native transcript", summaryMd: "Unknown generated summary" };
  const find = vi.fn().mockResolvedValue(row), lock = vi.fn().mockResolvedValue([]);
  return { row, find, lock, tx: { $queryRaw: lock, action: { findFirst: find }, tension: { findFirst: find }, proposal: { findFirst: find }, meeting: { findFirst: find } } as unknown as Prisma.TransactionClient };
}
describe("current notification draft lineage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    captureProof.mockImplementation(async (_actor, _workspaceId, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) })));
  });
  it.each([
    ["action.published", "Action", "Action"], ["tension.published", "Tension", "Tension"],
    ["proposal.submitted", "Proposal", "Proposal"], ["proposal.opened", "Proposal", "Proposal"],
    ["meeting.created", "Meeting", "MeetingTranscript"],
  ])("uses locked current inputs for %s rather than stale event text", async (type, aggregateType, kind) => {
    const { row, find, lock, tx } = fixture();
    const drafts = await deriveDispatchNotifications(tx, { type, workspaceId, aggregateType, aggregateId: row.id, payload: { title: "Old revoked title", bodyMd: "Old unsafe body" } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toContain(row.title);
    expect(JSON.stringify(drafts)).not.toMatch(/Old revoked|Old unsafe|Unknown generated/);
    expect(drafts[0].lineageRoots).toEqual([{ kind, id: row.id, fingerprint: "a".repeat(64) }]);
    expect(captureProof).toHaveBeenCalledWith(expect.objectContaining({ workspaceIds: [workspaceId] }), workspaceId,
      [{ kind, id: row.id, snapshot: kind === "MeetingTranscript" ? { id: row.id, workspaceId, title: row.title, transcript: row.transcript, createdAt: undefined } : row }], tx);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(find.mock.invocationCallOrder[0]);
    expect(find.mock.invocationCallOrder[0]).toBeLessThan(captureProof.mock.invocationCallOrder[0]);
    expect(find.mock.calls[0][0]).not.toHaveProperty("select");
  });
  it.each(["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED", "NOT_FOUND"])("withholds %s without falling back to event title", async (code) => {
    const { tx } = fixture();
    captureProof.mockRejectedValue(Object.assign(new Error("Unproved"), { code }));
    expect(await deriveDispatchNotifications(tx, { type: "action.published", workspaceId, aggregateType: "Action", aggregateId: "subject-1", payload: { title: "Old title" } })).toEqual([]);
  });
  it("does not certify unknown event kinds, mismatched entities, or replayed events", async () => {
    const { tx, lock } = fixture();
    for (const event of [
      { type: "action.created", aggregateType: "Action", payload: {} },
      { type: "action.published", aggregateType: "Tension", payload: {} },
      { type: "action.published", aggregateType: "Action", payload: { runtimeMeta: { replayOfEventId: "original" } } },
    ]) expect(await deriveDispatchNotifications(tx, { ...event, workspaceId, aggregateId: "subject-1" })).toEqual([]);
    expect(lock).not.toHaveBeenCalled();
    expect(captureProof).not.toHaveBeenCalled();
  });
});
