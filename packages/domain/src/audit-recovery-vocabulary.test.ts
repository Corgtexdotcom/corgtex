import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, readable: true }));
vi.mock("@corgtex/shared", () => ({ prisma: {
  auditLog: { findMany: async () => state.rows }, event: { findMany: async () => [] },
} }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: async () => ({ id: "member" }) }));
vi.mock("./agent-runs", () => ({ redactAgentRunContent: vi.fn() }));
vi.mock("./source-lineage", async original => ({
  ...await original<typeof import("./source-lineage")>(),
  sealArtifactInputActor: vi.fn(),
  captureArtifactInputProof: async () => state.readable ? [{ kind: "Action", id: "target", fingerprint: "original" }] : null,
  isArtifactInputProofReadable: async () => state.readable,
}));
vi.mock("./work-item-readable-page", () => ({ WorkItemReadRelease: class {
  observeRead = <T>(read: () => T) => read();
  add = () => {};
  finish = <T>(value: T) => value;
} }));
import { getEntityTimeline, listAuditLogsPage } from "./audit-trail";
import { LEGACY_RECOVERY_KINDS } from "./legacy-recovery";
const actor = { kind: "user", user: { id: "reader" } } as never;
beforeEach(() => { state.rows = []; state.readable = true; });
it.each(LEGACY_RECOVERY_KINDS)("admits the recovery operational fact for %s in both views with metadata redacted", async kind => {
  state.rows = [{ id: "audit", workspaceId: "ws", actorUserId: "reader", entityType: kind,
    entityId: "target", action: "legacy-history.recovered", createdAt: new Date(), meta: { receipt: "private" } }];
  expect((await listAuditLogsPage(actor, "ws")).items).toEqual([{ ...state.rows[0], meta: null }]);
  expect((await getEntityTimeline(actor, "ws", kind, "target")).auditLogs).toEqual([{ ...state.rows[0], meta: null }]);
});
it("does not admit recovery facts for unsupported readable kinds or arbitrary recovery text", async () => {
  for (const [kind, action] of [["BuildArtifact", "legacy-history.recovered"], ["Action", "legacy-history.recovered.secret"]]) {
    state.rows = [{ id: "audit", workspaceId: "ws", actorUserId: "reader", entityType: kind,
      entityId: "target", action, createdAt: new Date(), meta: { secret: "private" } }];
    expect((await listAuditLogsPage(actor, "ws")).items).toEqual([]);
    expect((await getEntityTimeline(actor, "ws", kind, "target")).auditLogs).toEqual([]);
  }
});
it("continues to withhold a supported recovery fact when its current target is unavailable", async () => {
  state.readable = false;
  state.rows = [{ id: "audit", workspaceId: "ws", entityType: "Action", entityId: "target",
    action: "legacy-history.recovered", createdAt: new Date() }];
  expect((await listAuditLogsPage(actor, "ws")).items).toEqual([]);
  expect((await getEntityTimeline(actor, "ws", "Action", "target")).auditLogs).toEqual([]);
});
