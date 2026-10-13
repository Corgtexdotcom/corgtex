import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const mocks = vi.hoisted(() => ({
  membership: vi.fn(), audit: vi.fn(), events: vi.fn(), duplicate: vi.fn(),
  db: {
    $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(),
    agentCredential: { findUnique: vi.fn() },
    action: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    workItemVersion: { create: vi.fn(), findUnique: vi.fn() },
    member: { findFirst: vi.fn() },
    actionCreationSource: { findUnique: vi.fn(), create: vi.fn() },
    actionChecklistItem: { findMany: vi.fn() },
  },
}));
vi.mock("@corgtex/shared", () => ({ prisma: mocks.db, mcpCredentialVersion: (hash: string) => `version:${hash}` }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: mocks.membership, actorUserIdForWorkspace: vi.fn() }));
vi.mock("./audit-trail", () => ({ recordAudit: mocks.audit }));
vi.mock("./events", () => ({ appendEvents: mocks.events }));
vi.mock("./duplicate-guard", () => ({ checkWorkspaceDuplicateGuard: mocks.duplicate, duplicateGuardAuditMeta: vi.fn(), duplicateGuardMergeText: (_existing: string, incoming: string) => incoming }));
import { completeAction, createAction, getAction, updateAction } from "./actions";

const actor: Extract<AppActor, { kind: "agent" }> = {
  kind: "agent", authProvider: "credential", label: "Synthetic action agent",
  workspaceIds: ["synthetic-workspace"], credentialId: "synthetic-agent",
  credentialVersion: "version:synthetic-hash", scopes: ["actions:write"],
};
const params = { workspaceId: "synthetic-workspace", actionId: "synthetic-action" };
const action = { id: "synthetic-action", workspaceId: "synthetic-workspace", title: "Original synthetic title",
  bodyMd: null, version: 1, status: "OPEN", isPrivate: false, archivedAt: null,
  duplicateOfActionId: null, assigneeMemberId: "synthetic-assignee", authorUserId: "synthetic-creator" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.membership.mockResolvedValue(null);
  mocks.db.$transaction.mockImplementation(async (run: (tx: typeof mocks.db) => Promise<unknown>) => run(mocks.db));
  mocks.db.agentCredential.findUnique.mockResolvedValue({ workspaceId: "synthetic-workspace", isActive: true,
    tokenHash: "synthetic-hash", scopes: ["actions:write", "actions:read"], createdBy: null, supportGrantVersion: null });
  mocks.db.action.findUnique.mockResolvedValue(action);
  mocks.db.action.findFirst.mockResolvedValue(action);
  mocks.db.actionChecklistItem.findMany.mockResolvedValue([]);
  mocks.db.actionCreationSource.findUnique.mockResolvedValue(null);
  mocks.duplicate.mockResolvedValue(null);
  mocks.db.member.findFirst.mockResolvedValue({ id: "synthetic-assignee", userId: "synthetic-assignee-user", kind: "HUMAN", user: { email: "assignee@example.test" } });
  mocks.db.action.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...action, ...data, version: 2 }));
});

describe("Action operation grants", () => {
  it("keeps canonical write-only completion allowed", async () => {
    await expect(completeAction(actor, { ...params, completedVia: "Synthetic completed note" })).resolves.toMatchObject({ status: "COMPLETED" });
    expect(mocks.db.action.update).toHaveBeenCalledOnce();
  });

  it("does not let completion forward undeclared content edits", async () => {
    const injectedTransaction = { action: { findUnique: vi.fn(), update: vi.fn() } };
    await expect(completeAction(actor, {
      ...params, completedVia: "Synthetic completed note", title: "Unpermitted title",
      bodyMd: "Unpermitted body", assigneeMemberId: "other-assignee",
      expectedVersion: -123, _tx: injectedTransaction,
    } as Parameters<typeof completeAction>[1])).resolves.toMatchObject({ status: "COMPLETED" });
    expect(mocks.db.action.update.mock.calls[0][0].data).not.toHaveProperty("title");
    expect(mocks.db.action.update.mock.calls[0][0].data).not.toHaveProperty("bodyMd");
    expect(mocks.db.action.update.mock.calls[0][0].data).not.toHaveProperty("assigneeMemberId");
    expect(injectedTransaction.action.findUnique).not.toHaveBeenCalled();
    expect(injectedTransaction.action.update).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).toHaveBeenCalledOnce();
  });

  it.each([false, true])("preserves write-only duplicate use_existing with a source claim %j", async withSource => {
    mocks.duplicate.mockResolvedValue({ resolution: "use_existing", match: { entityId: "synthetic-action" } });
    await expect(createAction(actor, { workspaceId: params.workspaceId, title: "Synthetic duplicate", duplicateGuard: { resolution: "use_existing" },
      ...(withSource ? { source: { type: "MCP_REQUEST", id: "synthetic-request" } } : {}),
    })).resolves.toMatchObject({ id: "synthetic-action" });
  });

  it.each([false, true])("preserves write-only duplicate update_existing with a source claim %j", async withSource => {
    mocks.duplicate.mockResolvedValue({ resolution: "update_existing", match: { entityId: "synthetic-action" } });
    await expect(createAction(actor, { workspaceId: params.workspaceId, title: "Synthetic duplicate", bodyMd: "Synthetic merged body", duplicateGuard: { resolution: "update_existing" },
      ...(withSource ? { source: { type: "MCP_REQUEST", id: "synthetic-request" } } : {}),
    })).resolves.toMatchObject({ bodyMd: "Synthetic merged body" });
    expect(mocks.db.action.update).toHaveBeenCalledOnce();
  });

  it("requires a read grant for general updates before record access", async () => {
    await expect(updateAction(actor, { ...params, title: "Unpermitted title" })).rejects.toMatchObject({ status: 403 });
    expect(mocks.db.action.findUnique).not.toHaveBeenCalled();
    expect(mocks.db.action.update).not.toHaveBeenCalled();
  });

  it("requires a read grant for get before record access", async () => {
    await expect(getAction(actor, params)).rejects.toMatchObject({ status: 403 });
    expect(mocks.db.action.findFirst).not.toHaveBeenCalled();
  });
});
