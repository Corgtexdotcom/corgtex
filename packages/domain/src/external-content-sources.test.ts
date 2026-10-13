import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ connection: vi.fn(), source: vi.fn(), transport: vi.fn() }));
vi.mock("@corgtex/shared", () => ({ prisma: { externalMcpConnection: { findFirst: fixture.connection } } }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn(async () => ({ id: "member" })) }));
vi.mock("./audit-trail", () => ({ recordAudit: vi.fn() }));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));
vi.mock("./external-provider-authority", () => ({
  assertExternalProviderCapturedResponseCurrent: vi.fn(), captureExternalProviderFetchInput: fixture.transport, registerExternalProviderRefetchCallback: vi.fn(),
  createExternalProviderSyncActor: vi.fn(async () => { throw Object.assign(new Error("Missing original selection proof"), { code: "UNKNOWN_LINEAGE" }); }),
  assertExternalProviderActorCurrent: vi.fn(), getExternalProviderPrincipalUserId: vi.fn(() => "owner"),
  isExternalProviderSelectionCurrent: vi.fn(),
}));
import { selectExternalContentSource, syncExternalContentSource } from "./external-content-sources";
const actor = { kind: "user" as const, user: { id: "owner", email: "owner@synthetic.test", displayName: "Owner" } };
describe("External content selection boundary", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects unsupported providers before inspecting connections", async () => {
    await expect(selectExternalContentSource(actor, { workspaceId: "ws", providerKey: "notion", sourceKind: "FILE", externalId: "file" })).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER" });
    expect(fixture.connection).not.toHaveBeenCalled();
  });
  it("rejects a broad crawl kind before inspecting connections", async () => {
    await expect(selectExternalContentSource(actor, { workspaceId: "ws", providerKey: "box", sourceKind: "WORKSPACE", externalId: "all" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fixture.connection).not.toHaveBeenCalled();
  });
  it("does not authorize a bare worker from serialized owner fields", async () => {
    await expect(selectExternalContentSource({ kind: "agent", authProvider: "bootstrap", label: "owner", workspaceIds: ["ws"] }, {
      workspaceId: "ws", providerKey: "box", sourceKind: "FILE", externalId: "file" })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(fixture.connection).not.toHaveBeenCalled();
  });
  it("selects only the current user's active workspace connection", async () => {
    fixture.connection.mockResolvedValue(null);
    await expect(selectExternalContentSource(actor, { workspaceId: "ws", providerKey: "box", sourceKind: "FILE", externalId: "file", connectionId: "other" })).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    expect(fixture.connection).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "other", workspaceId: "ws", userId: "owner", providerKey: "box", status: "ACTIVE" } }));
  });
  it("requires a scoped job and proven original selection before provider fetch or copying", async () => {
    const syncKnowledge = vi.fn();
    await expect(syncExternalContentSource({ workspaceId: "ws", sourceId: "legacy", syncKnowledge })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(syncExternalContentSource({ workspaceId: "ws", sourceId: "legacy", workflowJobId: "job", syncKnowledge })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(fixture.transport).not.toHaveBeenCalled(); expect(syncKnowledge).not.toHaveBeenCalled();
  });
});
