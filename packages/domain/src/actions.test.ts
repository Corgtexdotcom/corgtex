import { captureArtifactInputProof, readableArtifactIds } from "./source-lineage";
import { prepareProducerLineage, finishProducerLineage } from "./producer-lineage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpCredentialVersion, runWithMcpOrigin, type AppActor } from "@corgtex/shared";
import { AppError } from "./errors";

vi.mock("./producer-lineage", () => ({
  prepareProducerLineage: vi.fn().mockResolvedValue({ mode: "HUMAN_ORIGINAL", inputs: [], roots: [] }),
  finishProducerLineage: vi.fn().mockResolvedValue(undefined),
}));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    agentCredential: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    action: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    actionCreationSource: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    adviceProcess: {
      findMany: vi.fn(),
    },
    actionChecklistItem: {
      create: vi.fn(),
      delete: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    member: {
      findFirst: vi.fn(),
    },
    document: {
      findMany: vi.fn(),
    },
    workItemEvidence: {
      createMany: vi.fn(),
    },
    proposal: {
      findFirst: vi.fn(),
    },
    workItemVersion: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    workspacePermalink: {
      upsert: vi.fn(),
    },
  },
}));

const appendEvents = vi.fn();
const recordAudit = vi.fn();
const requireWorkspaceMembership = vi.fn();

vi.mock("@corgtex/shared", async () => ({
  ...await import("../../shared/src/mcp-context"),
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  actorUserIdForWorkspace: vi.fn(async () => "user-1"),
  requireWorkspaceMembership,
}));

vi.mock("./audit-trail", () => ({
  recordAudit,
}));

vi.mock("./events", () => ({
  appendEvents,
}));

vi.mock("./source-lineage", () => ({
  isArtifactInputProofReadable: vi.fn().mockResolvedValue(true),
  captureArtifactInputProof: vi.fn().mockResolvedValue([]),
  readableArtifactIds: vi.fn(async (_actor, _workspaceId, _kind, records) =>
    new Set(records.map((record: { id: string }) => record.id))),
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

function currentCredential(credentialId: string, scopes: string[]): Extract<AppActor, {kind: "agent"}> {
  const tokenHash = `synthetic-token-${credentialId}`;
  requireWorkspaceMembership.mockResolvedValue(null);
  prismaMock.agentCredential.findUnique.mockImplementation(async ({where}: {where: {id: string}}) => where.id === credentialId ? {
    id: credentialId, workspaceId: "workspace-1", isActive: true, tokenHash, scopes: [...scopes],
    createdBy: null, supportGrantVersion: null,
  } : null);
  return {kind: "agent", authProvider: "credential", credentialId, credentialVersion: mcpCredentialVersion(tokenHash),
    label: "Synthetic current credential", workspaceIds: ["workspace-1"], scopes: [...scopes]};
}

describe("action domain lifecycle", () => {
  it.each(["credential-a", "credential-b"])("rejects private creation by %s before duplicate reads or writes", async credentialId => {
    const {createAction} = await import("./actions");
    const credential = currentCredential(credentialId, ["actions:write"]);
    await expect(createAction(credential, {workspaceId: "workspace-1", title: "Private", authorMemberId: "member-owner"})).rejects.toMatchObject({code: "PRIVATE_AGENT_ARTIFACT_UNSUPPORTED"});
    expect(prismaMock.agentCredential.findUnique).toHaveBeenCalledWith(expect.objectContaining({where: {id: credentialId}}));
    expect(prismaMock.action.create).not.toHaveBeenCalled();
    expect(prismaMock.action.findMany).not.toHaveBeenCalled();
    expect(prismaMock.action.findFirst).not.toHaveBeenCalled();
  });
  it("rejects public agent creation without complete inputs before looking for duplicates", async () => {
    const {createAction} = await import("./actions");
    await expect(createAction({kind: "agent", workspaceIds: ["workspace-1"]} as any, {...{workspaceId: "workspace-1", title: "Private", authorMemberId: "member-owner"}, isPrivate: false}))
      .rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
    expect(prismaMock.action.create).not.toHaveBeenCalled();
    expect(prismaMock.action.findMany).not.toHaveBeenCalled();
  });

  it.each(["credential-a", "credential-b"])("does not return a hidden private action through a no-op update by %s", async credentialId => {
    const {updateAction} = await import("./actions");
    const credential = currentCredential(credentialId, ["actions:read", "actions:write"]);
    prismaMock.action.findUnique.mockResolvedValue({id: "private", workspaceId: "workspace-1", status: "DRAFT", isPrivate: true,
      title: "Private title", bodyMd: "Private text", lineageDenied: true, archivedAt: null});
    await expect(updateAction(credential, {workspaceId: "workspace-1", actionId: "private"})).rejects.toMatchObject({code: "NOT_FOUND"});
    expect(prismaMock.agentCredential.findUnique).toHaveBeenCalledWith(expect.objectContaining({where: {id: credentialId}}));
    expect(prismaMock.action.update).not.toHaveBeenCalled();
    expect(readableArtifactIds).toHaveBeenCalledWith(credential, "workspace-1", "Action", [expect.objectContaining({id: "private"})], prismaMock);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(captureArtifactInputProof).mockReset().mockResolvedValue([]);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, _kind, rows) =>
      new Set(rows.filter((row) => !(row as { lineageDenied?: boolean }).lineageDenied).map((row) => row.id)));
    prismaMock.action.findMany.mockReset().mockResolvedValue([]);
    prismaMock.actionChecklistItem.findMany.mockReset().mockResolvedValue([]);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.agentCredential.findUnique.mockResolvedValue({ workspaceId: "workspace-1", isActive: true, tokenHash: "synthetic-hash", scopes: ["actions:write"], createdBy: null, supportGrantVersion: null });
    recordAudit.mockResolvedValue(undefined);
    appendEvents.mockResolvedValue(undefined);
    prismaMock.$executeRaw.mockResolvedValue({});
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.workItemVersion.create.mockResolvedValue({});
    prismaMock.workItemVersion.findUnique.mockResolvedValue(null);
    prismaMock.workspacePermalink.upsert.mockResolvedValue({});
    prismaMock.member.findFirst.mockResolvedValue({ id: "member-2" });
    prismaMock.adviceProcess.findMany.mockResolvedValue([]);
    prismaMock.actionChecklistItem.findMany.mockResolvedValue([]);
    prismaMock.actionChecklistItem.findFirst.mockResolvedValue(null);
    prismaMock.actionChecklistItem.findUnique.mockResolvedValue(null);
    prismaMock.actionCreationSource.findUnique.mockResolvedValue(null);
    prismaMock.actionCreationSource.create.mockResolvedValue({});
  });

  it("reuses the same Action when a meeting insight is retried", async () => {
    const created = { id: "action-1", workspaceId: "workspace-1", title: "Follow up", status: "OPEN", archivedAt: null, duplicateOfActionId: null };
    prismaMock.action.create.mockResolvedValueOnce(created);
    prismaMock.actionCreationSource.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ actionId: created.id, payloadHash: null });
    prismaMock.action.findFirst.mockResolvedValueOnce(created);

    const { createAction } = await import("./actions");
    const params = { workspaceId: "workspace-1", title: "Follow up", isPrivate: false, assigneeMemberId: "member-2",
      source: { type: "MEETING_INSIGHT", id: "insight-1" }, sourcePayload: { title: "Follow up" } };
    await expect(createAction(actor, params)).resolves.toMatchObject({ id: created.id });
    await expect(createAction(actor, params)).resolves.toMatchObject({ id: created.id });

    expect(prismaMock.action.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.actionCreationSource.create).toHaveBeenCalledTimes(1);
  });

  it.each(["human", "mcp", "agent"])("classifies a GPT_REQUEST tag for %s without waiving captured roots", async principal => {
    const {actionRequestSource, createAction} = await import("./actions");
    const caller = principal === "agent" ? currentCredential("gpt-spoof", ["actions:write"]) : actor;
    const lineageRoots = [{kind: "BrainSource" as const, id: "restricted", fingerprint: "original"}];
    prismaMock.action.create.mockResolvedValueOnce({id: "tagged", workspaceId: "workspace-1", title: "Submitted"});
    const run = () => createAction(caller, {workspaceId: "workspace-1", title: "Submitted", lineageRoots,
      ...(principal === "agent" ? {isPrivate: false, assigneeMemberId: "member-2"} : {}),
      source: actionRequestSource("GPT_REQUEST", "user-1", "request-1")});
    if (principal === "mcp") await runWithMcpOrigin({kind: "oauth", id: "synthetic-origin", workspaceId: "workspace-1", scopeHash: "synthetic", grantEpoch: "0"}, run);
    else await run();
    expect(prepareProducerLineage).toHaveBeenCalledWith(expect.objectContaining({copied: principal !== "human",
      capture: expect.objectContaining({lineageRoots})}));
  });

  it("rejects reuse of a request key with different Action content", async () => {
    prismaMock.action.create.mockResolvedValueOnce({ id: "action-1", workspaceId: "workspace-1", title: "Follow up" });
    const { actionRequestSource, createAction } = await import("./actions");
    const source = actionRequestSource("WEB_REQUEST", "user-1", "form-1");
    await createAction(actor, { workspaceId: "workspace-1", title: "Follow up", source });
    const claim = prismaMock.actionCreationSource.create.mock.calls[0][0].data;
    prismaMock.actionCreationSource.findUnique.mockResolvedValueOnce({ actionId: "action-1", payloadHash: claim.payloadHash });

    await expect(createAction(actor, { workspaceId: "workspace-1", title: "A different action", source }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    expect(prismaMock.action.create).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of an agent request key with different author attribution", async () => {
    prismaMock.action.create.mockResolvedValueOnce({ id: "action-1", workspaceId: "workspace-1", title: "Follow up" });
    const { actionRequestSource, createAction } = await import("./actions");
    const agent: AppActor = { kind: "agent", authProvider: "credential", credentialId: "synthetic-agent", credentialVersion: mcpCredentialVersion("synthetic-hash"), scopes: ["actions:write"], label: "Test agent", workspaceIds: ["workspace-1"] };
    prismaMock.member.findFirst.mockResolvedValueOnce({ id: "member-1", userId: "author-1" });
    const source = actionRequestSource("MCP_REQUEST", "agent-1", "call-1");
    await createAction(agent, { workspaceId: "workspace-1", title: "Follow up", authorMemberId: "member-1", source, isPrivate: false, assigneeMemberId: "member-2", lineageRoots: [{kind: "BrainSource", id: "source-1", fingerprint: "current"}] });
    const claim = prismaMock.actionCreationSource.create.mock.calls[0][0].data;
    prismaMock.actionCreationSource.findUnique.mockResolvedValueOnce({ actionId: "action-1", payloadHash: claim.payloadHash });

    await expect(createAction(agent, { workspaceId: "workspace-1", title: "Follow up", authorMemberId: "member-2", source, isPrivate: false, assigneeMemberId: "member-2", lineageRoots: [{kind: "BrainSource", id: "source-1", fingerprint: "current"}] }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    expect(prismaMock.action.create).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a form key with changed Action add-ons", async () => {
    prismaMock.action.create.mockResolvedValueOnce({ id: "action-1", workspaceId: "workspace-1", title: "Follow up" });
    const { actionRequestSource, createAction } = await import("./actions");
    const source = actionRequestSource("WEB_REQUEST", "user-1", "form-with-checklist");
    await createAction(actor, { workspaceId: "workspace-1", title: "Follow up", source, sourcePayload: { checklistItems: ["First"] } });
    const claim = prismaMock.actionCreationSource.create.mock.calls[0][0].data;
    prismaMock.actionCreationSource.findUnique.mockResolvedValueOnce({ actionId: "action-1", payloadHash: claim.payloadHash });

    await expect(createAction(actor, {
      workspaceId: "workspace-1", title: "Follow up", source, sourcePayload: { checklistItems: ["Changed"] },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(prismaMock.action.create).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a request key with a different selected duplicate target", async () => {
    const existing = {
      id: "action-1", workspaceId: "workspace-1", title: "Follow up", bodyMd: null,
      status: "OPEN", isPrivate: false, archivedAt: null, duplicateOfActionId: null,
      createdAt: new Date("2026-07-20T10:00:00.000Z"), updatedAt: new Date("2026-07-20T10:05:00.000Z"),
    };
    prismaMock.action.findMany.mockResolvedValueOnce([existing]);
    prismaMock.action.findFirst.mockResolvedValueOnce(existing);
    const { actionRequestSource, createAction } = await import("./actions");
    const source = actionRequestSource("MCP_REQUEST", "agent-1", "selected-target");
    await createAction(actor, {
      workspaceId: "workspace-1", title: "Follow up", source,
      duplicateGuard: { resolution: "use_existing", targetEntityId: "action-1" },
    });
    const claim = prismaMock.actionCreationSource.create.mock.calls[0][0].data;
    prismaMock.actionCreationSource.findUnique.mockResolvedValueOnce({ actionId: "action-1", payloadHash: claim.payloadHash });

    await expect(createAction(actor, {
      workspaceId: "workspace-1", title: "Follow up", source,
      duplicateGuard: { resolution: "use_existing", targetEntityId: "action-2" },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    expect(prismaMock.actionCreationSource.create).toHaveBeenCalledTimes(1);
  });

  it("rejects an edited meeting insight after an earlier attempt claimed its Action source", async () => {
    prismaMock.action.create.mockResolvedValueOnce({ id: "action-1", workspaceId: "workspace-1", title: "Follow up" });
    const { createAction, meetingInsightActionSourcePayload } = await import("./actions");
    const source = { type: "MEETING_INSIGHT", id: "insight-1" };
    const insight = {
      type: "ACTION_ITEM" as const, operation: "CREATE" as const, title: "Follow up", bodyMd: "Initial context",
      assigneeHint: null, dueAt: null,
    };
    await createAction(actor, {
      workspaceId: "workspace-1", title: insight.title, source,
      sourcePayload: meetingInsightActionSourcePayload(insight),
    });
    const claim = prismaMock.actionCreationSource.create.mock.calls[0][0].data;
    prismaMock.actionCreationSource.findUnique.mockResolvedValueOnce({ actionId: "action-1", payloadHash: claim.payloadHash });

    await expect(createAction(actor, {
      workspaceId: "workspace-1", title: insight.title, source,
      sourcePayload: meetingInsightActionSourcePayload({ ...insight, bodyMd: "Edited context" }),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    expect(prismaMock.action.create).toHaveBeenCalledTimes(1);
  });

  it("returns the canonical Action for a retried source after an exact duplicate is archived", async () => {
    prismaMock.actionCreationSource.findUnique.mockResolvedValueOnce({ actionId: "duplicate-1", payloadHash: null });
    prismaMock.action.findFirst
      .mockResolvedValueOnce({ id: "duplicate-1", workspaceId: "workspace-1", archivedAt: new Date(), duplicateOfActionId: "canonical-1" })
      .mockResolvedValueOnce({ id: "canonical-1", workspaceId: "workspace-1", archivedAt: null });

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1", title: "Follow up", source: { type: "MEETING_INSIGHT", id: "insight-1" }, sourcePayload: { title: "Follow up" },
    })).resolves.toMatchObject({ id: "canonical-1" });
    expect(prismaMock.action.create).not.toHaveBeenCalled();
  });

  it("rejects an archived source Action instead of reporting an inactive follow-up", async () => {
    prismaMock.actionCreationSource.findUnique.mockResolvedValueOnce({ actionId: "archived-1", payloadHash: null });
    prismaMock.action.findFirst.mockResolvedValueOnce({
      id: "archived-1", workspaceId: "workspace-1", archivedAt: new Date(), duplicateOfActionId: null,
    });

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1", title: "Follow up", source: { type: "MEETING_INSIGHT", id: "insight-archived" }, sourcePayload: { title: "Follow up" },
    })).rejects.toMatchObject({ code: "ACTION_SOURCE_UNAVAILABLE", status: 409 });
    expect(prismaMock.action.create).not.toHaveBeenCalled();
  });

  it("updates a duplicate and records its source in the same transaction", async () => {
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1", workspaceId: "workspace-1", userId: "user-1", role: "ADMIN", isActive: true,
    });
    const existing = {
      id: "action-1", workspaceId: "workspace-1", authorUserId: "user-1",
      title: "Send Acme proposal", bodyMd: "Initial context.", status: "OPEN",
      isPrivate: false, archivedAt: null, duplicateOfActionId: null, version: 1,
      createdAt: new Date("2026-09-26T10:00:00Z"), updatedAt: new Date("2026-09-26T10:00:00Z"),
    };
    prismaMock.action.findMany.mockResolvedValueOnce([existing]);
    prismaMock.action.findFirst.mockResolvedValueOnce(existing);
    prismaMock.action.findUnique.mockResolvedValueOnce(existing);
    prismaMock.action.update.mockResolvedValueOnce({ ...existing, bodyMd: "Initial context.\n\nAdditional context." });

    const { createAction } = await import("./actions");
    await createAction(actor, {
      workspaceId: "workspace-1", title: "Send Acme proposal", bodyMd: "Additional context.",
      source: { type: "MEETING_INSIGHT", id: "insight-2" }, sourcePayload: { title: "Send Acme proposal" },
      duplicateGuard: { resolution: "update_existing", targetEntityId: "action-1" },
    });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.action.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.actionCreationSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actionId: "action-1", sourceType: "MEETING_INSIGHT", sourceId: "insight-2" }),
    });
    expect(prismaMock.action.update.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.actionCreationSource.create.mock.invocationCallOrder[0]);
  });

  it("creates form-submitted actions as private drafts by default", async () => {
    prismaMock.action.create.mockResolvedValueOnce({
      id: "action-private",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
    });

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: " Follow up ",
      bodyMd: " Notes ",
      priority: 4,
    })).resolves.toMatchObject({
      id: "action-private",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
    });

    expect(prismaMock.action.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        title: "Follow up",
        bodyMd: "Notes",
        priority: 4,
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
      }),
    });
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.created",
      entityId: "action-private",
    }));
    expect(recordAudit).not.toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.published",
    }));
  });

  it("reuses a supplied transaction for atomic composed Action writes", async () => {
    prismaMock.action.create.mockResolvedValueOnce({
      id: "action-composed",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Publish from Slack",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-08-10T12:00:00.000Z"),
    });

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Publish from Slack",
      isPrivate: false,
      _tx: prismaMock as never,
      assigneeMemberId: "member-2",
    })).resolves.toMatchObject({ id: "action-composed", status: "OPEN" });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.action.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "OPEN",
        isPrivate: false,
        publishedAt: expect.any(Date),
      }),
    });
    expect(recordAudit).toHaveBeenCalledWith(prismaMock, actor, expect.objectContaining({
      action: "action.published",
      entityId: "action-composed",
    }));
  });

  it("fills a missing proposal link when updating an existing duplicate action", async () => {
    const existingAction = {
      id: "action-existing",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Send Acme proposal",
      bodyMd: null,
      assigneeMemberId: null,
      dueAt: null,
      proposalId: null,
      circleId: null,
      priority: 1,
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
      archivedAt: null,
      version: 1,
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
      updatedAt: new Date("2026-07-20T10:05:00.000Z"),
    };
    prismaMock.action.findMany.mockResolvedValueOnce([existingAction]);
    prismaMock.action.findFirst.mockResolvedValueOnce(existingAction);
    prismaMock.action.findUnique.mockResolvedValueOnce(existingAction);
    prismaMock.proposal.findFirst.mockResolvedValueOnce({ id: "proposal-1" });
    prismaMock.action.update.mockResolvedValueOnce({
      ...existingAction,
      proposalId: "proposal-1",
      priority: 5,
      version: 2,
    });

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Send Acme proposal",
      proposalId: "proposal-1",
      priority: 5,
      duplicateGuard: {
        resolution: "update_existing",
        targetEntityId: "action-existing",
      },
    })).resolves.toMatchObject({
      id: "action-existing",
      proposalId: "proposal-1",
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-existing" }),
      data: expect.objectContaining({
        proposalId: "proposal-1",
        priority: 5,
        version: expect.any(Number),
      }),
    }));
  });

  it("stops likely duplicate actions before creating a new row", async () => {
    prismaMock.action.findMany.mockResolvedValueOnce([
      {
        id: "action-existing",
        workspaceId: "workspace-1",
        title: "Send Acme proposal",
        bodyMd: null,
        assigneeMemberId: "member-2",
        dueAt: new Date("2026-07-24T09:00:00.000Z"),
        status: "OPEN",
        isPrivate: false,
        archivedAt: null,
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
        updatedAt: new Date("2026-07-20T10:05:00.000Z"),
      },
    ]);

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Send proposal to Acme",
      assigneeMemberId: "member-2",
      dueAt: new Date("2026-07-24T16:00:00.000Z"),
      duplicateGuard: {},
    })).rejects.toMatchObject({
      status: 409,
      code: "DUPLICATE_GUARD_MATCH",
      candidate: expect.objectContaining({
        entityId: "action-existing",
        matchKind: "likely",
      }),
    });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.action.create).not.toHaveBeenCalled();
  });

  it("creates an action with a valid assignee member", async () => {
    prismaMock.action.create.mockResolvedValueOnce({
      id: "action-assigned",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      assigneeMemberId: "member-2",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
    });

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Follow up",
      assigneeMemberId: "member-2",
    })).resolves.toMatchObject({
      id: "action-assigned",
      assigneeMemberId: "member-2",
    });

    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "member-2",
        workspaceId: "workspace-1",
        isActive: true,
        NOT: expect.any(Array),
      }),
      select: { id: true },
    });
    expect(prismaMock.action.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assigneeMemberId: "member-2",
      }),
    });
  });

  it("rejects invalid action assignees", async () => {
    prismaMock.member.findFirst.mockResolvedValueOnce(null);

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Follow up",
      assigneeMemberId: "missing-member",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prismaMock.action.create).not.toHaveBeenCalled();
  });

  it("combines member filters with the existing privacy filter", async () => {
    prismaMock.action.findMany.mockResolvedValueOnce([{ id: "action-1" }]);
    prismaMock.action.count.mockResolvedValueOnce(0);
    prismaMock.adviceProcess.findMany.mockResolvedValueOnce([
      {
        subjectId: "action-1",
        requests: [
          { id: "request-active", status: "ACTIVE" },
          { id: "request-completed", status: "COMPLETED" },
        ],
      },
    ]);

    const { listActions } = await import("./actions");
    await expect(listActions(actor, "workspace-1", { memberId: "member-1", circleId: "circle-1", sort: "alpha" })).resolves.toMatchObject({
      items: [
        {
          id: "action-1",
          inputRequestCount: 2,
          activeInputRequestCount: 1,
        },
      ],
    });

    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        circleId: "circle-1",
        AND: [
          {
            OR: [
              { isPrivate: false },
              { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
            ],
          },
          {
            OR: [
              { assigneeMemberId: { in: ["member-1"] } },
              {
                author: {
                  memberships: {
                    some: {
                      id: { in: ["member-1"] },
                      workspaceId: "workspace-1",
                      isActive: true,
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
      orderBy: [
        { title: "asc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
    }));
    expect(prismaMock.adviceProcess.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        subjectType: "ACTION",
        subjectId: { in: ["action-1"] },
      },
      select: {
        subjectId: true,
        requests: true,
      },
    });
  });

  it.each([
    ["date", [{ createdAt: "desc" }, { id: "desc" }]],
    ["created_asc", [{ createdAt: "asc" }, { id: "asc" }]],
    ["due_asc", [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }]],
    ["due_desc", [{ dueAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }]],
  ] as const)("orders the full filtered Action query by %s before limiting the page", async (sort, orderBy) => {
    const permitted = Array.from({ length: 237 }, (_, index) => ({ id: `action-${String(index).padStart(3, "0")}`, status: "OPEN" }));
    prismaMock.action.findMany.mockResolvedValueOnce([{ id: "hidden-earlier", lineageDenied: true }, ...permitted]);

    const { listActions } = await import("./actions");
    const result = await listActions(actor, "workspace-1", { sort, take: 25, skip: 50 });

    expect(result).toMatchObject({ total: 237, take: 25, skip: 50 });
    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "workspace-1" }),
      orderBy,
      take: 5001,
    }));
    expect(prismaMock.action.findMany.mock.calls[0][0]).not.toHaveProperty("skip");
    expect(result.items.map((item) => item.id)).toEqual(permitted.slice(50, 75).map((item) => item.id));
    expect(prismaMock.action.count).not.toHaveBeenCalled();
  });

  it("applies the selected lifecycle status before due sorting and pagination", async () => {
    const records = [
      { id: "action-000", status: "OPEN" },
      ...Array.from({ length: 205 }, (_, index) => ({ id: `action-${String(index + 1).padStart(3, "0")}`, status: "COMPLETED" })),
      { id: "action-hidden", status: "OPEN", lineageDenied: true },
    ];
    prismaMock.action.findMany.mockImplementation(async (query) => {
      const where = query.where.AND?.[0] ?? query.where;
      const afterId = query.where.AND?.find((clause: { id?: { gt?: string } }) => clause.id?.gt)?.id.gt;
      return records.filter((record) => (!where.status?.in || where.status.in.includes(record.status))
        && (!afterId || record.id > afterId)).slice(0, query.take);
    });

    const { countActionsByStatus, listActions } = await import("./actions");
    const result = await listActions(actor, "workspace-1", { statuses: ["OPEN"], sort: "due_asc", take: 200 });
    const counts = await countActionsByStatus(actor, "workspace-1");

    expect(result.total).toBe(1);
    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["OPEN"] } }),
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }],
      take: 5001,
    }));
    expect(prismaMock.action.groupBy).not.toHaveBeenCalled();
    expect(prismaMock.action.count).not.toHaveBeenCalled();
    expect(counts).toEqual({ DRAFT: 0, OPEN: 1, IN_PROGRESS: 0, COMPLETED: 205, ALL: 206 });
  });

  it("returns checklist progress only as action summary counts", async () => {
    prismaMock.action.findMany.mockResolvedValueOnce([
      { id: "action-1" },
      { id: "action-2" },
    ]);
    prismaMock.action.count.mockResolvedValueOnce(2);
    prismaMock.actionChecklistItem.findMany.mockResolvedValueOnce([
      { actionId: "action-1", completedAt: new Date("2026-07-20T10:00:00.000Z") },
      { actionId: "action-1", completedAt: null },
      { actionId: "action-2", completedAt: null },
    ]);

    const { listActions } = await import("./actions");
    await expect(listActions(actor, "workspace-1")).resolves.toMatchObject({
      items: [
        {
          id: "action-1",
          checklistItemCount: 2,
          checklistCompletedCount: 1,
        },
        {
          id: "action-2",
          checklistItemCount: 1,
          checklistCompletedCount: 0,
        },
      ],
    });

    expect(prismaMock.actionChecklistItem.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        actionId: { in: ["action-1", "action-2"] },
      },

    });
  });

  it("filters exact assignees separately from broader member involvement", async () => {
    prismaMock.action.findMany.mockResolvedValueOnce([]);
    prismaMock.action.count.mockResolvedValueOnce(0);

    const { listActions } = await import("./actions");
    await listActions(actor, "workspace-1", {
      assigneeMemberIds: ["member-2", "member-2", ""],
    });

    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        assigneeMemberId: { in: ["member-2"] },
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
        ],
      }),
    }));
  });

  it("includes only the author's private drafts alongside their assigned Actions in the personal scope", async () => {
    prismaMock.action.findMany.mockResolvedValueOnce([]);
    prismaMock.action.count.mockResolvedValueOnce(0);
    const { listActions } = await import("./actions");
    await listActions(actor, "workspace-1", { assigneeMemberIds: ["member-1"], includeOwnDrafts: true });
    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        AND: [
          { OR: [
            { isPrivate: false },
            { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
          ] },
          { OR: [
            { assigneeMemberId: "member-1" },
            { authorUserId: "user-1", isPrivate: true, status: "DRAFT" },
          ] },
        ],
      }),
    }));
  });

  it("creates unchecked-private actions as open public records", async () => {
    prismaMock.action.create.mockResolvedValueOnce({
      id: "action-public",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-05-26T12:00:00.000Z"),
    });

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Follow up",
      isPrivate: false,
      assigneeMemberId: "member-2",
    })).resolves.toMatchObject({
      id: "action-public",
      status: "OPEN",
      isPrivate: false,
    });

    expect(prismaMock.action.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "OPEN",
        isPrivate: false,
        publishedAt: expect.any(Date),
      }),
    });
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.created",
      entityId: "action-public",
    }));
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.published",
      entityId: "action-public",
    }));
    expect(appendEvents).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        type: "action.published",
        aggregateId: "action-public",
        payload: { actionId: "action-public", assigneeMemberId: "member-2", actorUserId: "user-1" },
      }),
    ]);
  });

  it("opens an existing public draft action to recover records created by the bad form default", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "DRAFT",
      isPrivate: false,
      assigneeMemberId: "member-2",
      publishedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-04-26T12:00:00.000Z"),
    });

    const { publishAction } = await import("./actions");
    await expect(publishAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
    })).resolves.toMatchObject({
      id: "action-1",
      status: "OPEN",
      isPrivate: false,
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-1" }),
      data: expect.objectContaining({
        status: "OPEN",
        isPrivate: false,
        publishedAt: expect.any(Date),
      }),
    }));
  });

  it("keeps unassigned drafts but rejects opening an Action without a human owner", async () => {
    prismaMock.action.create.mockResolvedValueOnce({ id: "draft-1", workspaceId: "workspace-1", status: "DRAFT" });
    const { createAction, publishAction } = await import("./actions");
    await expect(createAction(actor, { workspaceId: "workspace-1", title: "Follow up" }))
      .resolves.toMatchObject({ status: "DRAFT" });
    await expect(createAction(actor, { workspaceId: "workspace-1", title: "Follow up", isPrivate: false }))
      .rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
    expect(prismaMock.action.create).toHaveBeenCalledTimes(1);

    prismaMock.action.findUnique.mockResolvedValueOnce({
      id: "draft-1", workspaceId: "workspace-1", authorUserId: "user-1", status: "DRAFT",
      assigneeMemberId: null, archivedAt: null, duplicateOfActionId: null,
    });
    await expect(publishAction(actor, { workspaceId: "workspace-1", actionId: "draft-1" }))
      .rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
    expect(prismaMock.action.update).not.toHaveBeenCalled();
  });

  it("rejects a system assignee on create and promotion", async () => {
    prismaMock.member.findFirst.mockResolvedValue(null);
    const { createAction, publishAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1", title: "Follow up", isPrivate: false, assigneeMemberId: "system-member",
    })).rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
    prismaMock.action.findUnique.mockResolvedValueOnce({
      id: "draft-1", workspaceId: "workspace-1", authorUserId: "user-1", status: "DRAFT",
      assigneeMemberId: "system-member", archivedAt: null, duplicateOfActionId: null,
    });
    await expect(publishAction(actor, { workspaceId: "workspace-1", actionId: "draft-1" }))
      .rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
    expect(prismaMock.action.update).not.toHaveBeenCalled();
  });

  it("does not clear the owner of an open Action or promote an unassigned draft through update", async () => {
    const { updateAction } = await import("./actions");
    prismaMock.action.findUnique.mockResolvedValueOnce({
      id: "open-1", workspaceId: "workspace-1", authorUserId: "user-1", status: "OPEN",
      assigneeMemberId: "member-2", version: 1, isPrivate: false, archivedAt: null, duplicateOfActionId: null,
    });
    await expect(updateAction(actor, {
      workspaceId: "workspace-1", actionId: "open-1", assigneeMemberId: null,
    })).rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
    prismaMock.action.findUnique.mockResolvedValueOnce({
      id: "draft-1", workspaceId: "workspace-1", authorUserId: "user-1", status: "DRAFT",
      assigneeMemberId: null, version: 1, isPrivate: true, archivedAt: null, duplicateOfActionId: null,
    });
    await expect(updateAction(actor, {
      workspaceId: "workspace-1", actionId: "draft-1", status: "OPEN",
    })).rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
    expect(prismaMock.action.update).not.toHaveBeenCalled();
  });

  it("emits one publication event when an assigned draft opens through update", async () => {
    prismaMock.action.findUnique.mockResolvedValueOnce({
      id: "draft-1", workspaceId: "workspace-1", authorUserId: "user-1",
      title: "Visible action", status: "DRAFT", isPrivate: true, assigneeMemberId: "member-2",
      version: 1, archivedAt: null, duplicateOfActionId: null, publishedAt: null,
    });
    prismaMock.action.update.mockResolvedValueOnce({
      id: "draft-1", workspaceId: "workspace-1", title: "Visible action",
      status: "OPEN", isPrivate: false, assigneeMemberId: "member-2", version: 1,
    });
    const { updateAction } = await import("./actions");

    await updateAction(actor, { workspaceId: "workspace-1", actionId: "draft-1", status: "OPEN" });

    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.published", entityId: "draft-1",
    }));
    expect(appendEvents).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
      type: "action.published", aggregateId: "draft-1",
      payload: { actionId: "draft-1", assigneeMemberId: "member-2", actorUserId: "user-1" },
    })]);
    expect(appendEvents).toHaveBeenCalledTimes(2);
  });

  it("allows an open Action to return to draft while clearing its assignee atomically", async () => {
    prismaMock.action.findUnique.mockResolvedValueOnce({
      id: "open-1", workspaceId: "workspace-1", authorUserId: "user-1", status: "OPEN",
      assigneeMemberId: "member-2", version: 1, isPrivate: false, archivedAt: null, duplicateOfActionId: null,
    });
    prismaMock.action.update.mockResolvedValueOnce({ id: "open-1", status: "DRAFT", assigneeMemberId: null, version: 2 });
    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1", actionId: "open-1", status: "DRAFT", assigneeMemberId: null, expectedVersion: 1,
    })).resolves.toMatchObject({ status: "DRAFT", assigneeMemberId: null });
    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "DRAFT", assigneeMemberId: null, isPrivate: true }),
    }));
  });

  it("treats a repeated publish of an active Action as a no-op", async () => {
    const opened = {
      id: "action-open", workspaceId: "workspace-1", authorUserId: "user-1",
      title: "Follow up", status: "IN_PROGRESS", isPrivate: false,
      archivedAt: null, duplicateOfActionId: null,
    };
    prismaMock.action.findUnique.mockResolvedValueOnce(opened);

    const { publishAction } = await import("./actions");
    await expect(publishAction(actor, { workspaceId: "workspace-1", actionId: opened.id })).resolves.toBe(opened);
    expect(prismaMock.action.update).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(appendEvents).not.toHaveBeenCalled();
  });

  it("returns an open action to draft for the draft owner", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-04-26T12:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
    });

    const { returnActionToDraft } = await import("./actions");
    await expect(returnActionToDraft(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
    })).resolves.toMatchObject({
      id: "action-1",
      status: "DRAFT",
      isPrivate: true,
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-1" }),
      data: expect.objectContaining({
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        completedVia: null,
      }),
    }));
  });

  it("returns a completed action to draft and clears completion state", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "COMPLETED",
      completedVia: "Done",
      isPrivate: false,
      publishedAt: new Date("2026-04-26T12:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      status: "DRAFT",
      isPrivate: true,
      completedVia: null,
      publishedAt: null,
    });

    const { returnActionToDraft } = await import("./actions");
    await expect(returnActionToDraft(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
    })).resolves.toMatchObject({
      id: "action-1",
      status: "DRAFT",
      isPrivate: true,
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-1" }),
      data: expect.objectContaining({
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        completedVia: null,
      }),
    }));
  });

  it("allows an author to edit an open action and snapshots the previous version", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      bodyMd: "Old notes",
      priority: 1,
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up now",
      status: "OPEN",
      version: 2,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Follow up now",
      priority: 5,
      expectedVersion: 1,
    })).resolves.toMatchObject({
      id: "action-1",
      version: 2,
    });

    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Action",
        entityId: "action-1",
        version: 1,
        changedFields: ["title", "priority"],
        previousState: expect.objectContaining({
          title: "Follow up",
          priority: 1,
          version: 1,
        }),
      }),
    }));
    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-1" }),
      data: { title: "Follow up now", priority: 5, version: 2 },
    }));
  });

  it("updates an action assignee and snapshots the previous version", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      bodyMd: "Old notes",
      assigneeMemberId: null,
      priority: 1,
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      assigneeMemberId: "member-2",
      status: "OPEN",
      version: 2,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      assigneeMemberId: "member-2",
      expectedVersion: 1,
    })).resolves.toMatchObject({
      assigneeMemberId: "member-2",
      version: 2,
    });

    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "member-2",
        workspaceId: "workspace-1",
        isActive: true,
        NOT: expect.any(Array),
      }),
      select: { id: true },
    });
    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Action",
        entityId: "action-1",
        changedFields: ["assigneeMemberId"],
      }),
    }));
    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-1" }),
      data: { assigneeMemberId: "member-2", version: 2 },
    }));
  });

  it("emits a targeted assignment event when a public Action changes owner", async () => {
    prismaMock.action.findUnique.mockResolvedValueOnce({
      id: "action-1", workspaceId: "workspace-1", authorUserId: "user-1",
      title: "Follow up", status: "OPEN", isPrivate: false, version: 1,
      assigneeMemberId: "member-2", archivedAt: null, duplicateOfActionId: null,
    });
    prismaMock.member.findFirst.mockResolvedValue({ id: "member-3" });
    prismaMock.action.update.mockResolvedValueOnce({
      id: "action-1", workspaceId: "workspace-1", title: "Follow up",
      status: "OPEN", isPrivate: false, version: 2, assigneeMemberId: "member-3",
    });

    const { updateAction } = await import("./actions");
    await updateAction(actor, {
      workspaceId: "workspace-1", actionId: "action-1", assigneeMemberId: "member-3", expectedVersion: 1,
    });

    expect(appendEvents).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
      type: "action.assigned",
      workspaceId: "workspace-1",
      aggregateType: "Action",
      aggregateId: "action-1",
      payload: { actionId: "action-1", assigneeMemberId: "member-3", actorUserId: "user-1" },
    })]);
  });

  it("keeps draft assignment private until the Action is published", async () => {
    prismaMock.action.findUnique.mockResolvedValueOnce({
      id: "draft-1", workspaceId: "workspace-1", authorUserId: "user-1",
      title: "Private follow up", status: "DRAFT", isPrivate: true, version: 1,
      assigneeMemberId: "member-2", archivedAt: null, duplicateOfActionId: null,
    });
    prismaMock.member.findFirst.mockResolvedValue({ id: "member-3" });
    prismaMock.action.update.mockResolvedValueOnce({
      id: "draft-1", workspaceId: "workspace-1", title: "Private follow up",
      status: "DRAFT", isPrivate: true, version: 2, assigneeMemberId: "member-3",
    });

    const { updateAction } = await import("./actions");
    await updateAction(actor, {
      workspaceId: "workspace-1", actionId: "draft-1", assigneeMemberId: "member-3", expectedVersion: 1,
    });

    expect(appendEvents.mock.calls.flatMap(([, events]) => events).map((event) => event.type))
      .toEqual(["action.updated"]);
  });

  it("allows an assigned member to edit an open action and snapshots the previous version", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      assigneeMemberId: "member-2",
      title: "Follow up",
      bodyMd: "Old notes",
      priority: 1,
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      assigneeMemberId: "member-2",
      title: "Assignee update",
      status: "OPEN",
      version: 2,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction({
      kind: "user",
      user: {
        id: "user-2",
        email: "assignee@example.com",
        displayName: "Assignee",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Assignee update",
      expectedVersion: 1,
    })).resolves.toMatchObject({
      id: "action-1",
      version: 2,
    });

    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Action",
        entityId: "action-1",
        version: 1,
        changedFields: ["title"],
      }),
    }));
    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-1" }),
      data: { title: "Assignee update", version: 2 },
    }));
  });

  it("allows any active member to edit a public open action", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-3",
      workspaceId: "workspace-1",
      userId: "user-3",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      assigneeMemberId: "member-2",
      title: "Follow up",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      assigneeMemberId: "member-2",
      title: "Allowed update",
      status: "OPEN",
      version: 2,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction({
      kind: "user",
      user: {
        id: "user-3",
        email: "other@example.com",
        displayName: "Other",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Allowed update",
      expectedVersion: 1,
    })).resolves.toMatchObject({
      id: "action-1",
      version: 2,
    });

    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Action",
        entityId: "action-1",
        changedFields: ["title"],
      }),
    }));
    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-1" }),
      data: { title: "Allowed update", version: 2 },
    }));
  });

  it("rejects stale collaborative action edits when the action changes before write", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-3",
      workspaceId: "workspace-1",
      userId: "user-3",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      title: "Follow up",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.workItemVersion.findUnique.mockResolvedValueOnce({ id: "v1-exists" } as any);

    const { updateAction } = await import("./actions");
    await expect(updateAction({
      kind: "user",
      user: {
        id: "user-3",
        email: "other@example.com",
        displayName: "Other",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Stale edit",
      expectedVersion: 1,
    })).rejects.toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      message: "The record changed before this update could be applied. Please refresh and try again.",
    });

    expect(prismaMock.action.update).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(appendEvents).not.toHaveBeenCalled();
  });

  it("honors expectedVersion and succeeds if it matches current version", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      title: "Follow up",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({ id: "action-1", version: 2 });
    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Versioned edit",
      expectedVersion: 1,
    })).resolves.toMatchObject({
      id: "action-1",
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith({
      where: {
        id: "action-1",
        workspaceId: "workspace-1",
        archivedAt: null,
        status: "OPEN",
        isPrivate: false,
        version: 1,
      },
      data: expect.objectContaining({
        version: 2,
      }),
    });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(appendEvents).toHaveBeenCalledTimes(1);
    expect(prismaMock.workItemVersion.create).toHaveBeenCalledTimes(1);
  });

  it("proposed contract: a stale caller cannot overwrite content by omitting its observed version", async () => {
    const stored = {
      id: "action-stale-omitted",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Original title",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
      duplicateOfActionId: null,
    };
    const secondCallersObservedVersion = stored.version;
    prismaMock.action.findUnique.mockImplementation(async () => ({ ...stored }));
    prismaMock.action.update.mockImplementation(async ({ where, data }: {
      where: { version: number };
      data: { title: string; version: number };
    }) => {
      expect(where.version).toBe(stored.version);
      Object.assign(stored, data);
      return { ...stored };
    });

    const { updateAction } = await import("./actions");
    await updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: stored.id,
      title: "First editor",
      expectedVersion: secondCallersObservedVersion,
    });
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: stored.id,
      title: "Second editor from a stale view",
      // This caller also observed version 1, but the domain API lets it omit it.
    })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });

    expect(prismaMock.action.update.mock.calls.map(([call]) => call.where.version)).toEqual([1]);
    expect(stored.title).toBe("First editor");
  });

  it("rejects missing versions for same-value and mixed content intent without effects", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1", workspaceId: "workspace-1", authorUserId: "user-1",
      title: "Current title", status: "OPEN", version: 2, isPrivate: false,
      assigneeMemberId: "member-2", archivedAt: null, duplicateOfActionId: null,
    });
    const { updateAction } = await import("./actions");

    for (const params of [
      { title: "Current title" },
      { title: "Changed title", status: "IN_PROGRESS" as const },
    ]) {
      await expect(updateAction(actor, { workspaceId: "workspace-1", actionId: "action-1", ...params }))
        .rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    }

    expect(prismaMock.action.update).not.toHaveBeenCalled();
    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(appendEvents).not.toHaveBeenCalled();
  });

  it("honors expectedVersion and rejects early if it does not match current version without side effects", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      title: "Follow up",
      status: "OPEN",
      version: 2,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Versioned edit",
      expectedVersion: 1,
    })).rejects.toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      message: "The record changed before this update could be applied. Please refresh and try again.",
    });

    expect(prismaMock.action.update).not.toHaveBeenCalled();
    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(appendEvents).not.toHaveBeenCalled();
  });

  it("locks before the authoritative Action no-op read and rejects a concurrently advanced version without side effects", async () => {
    prismaMock.action.findUnique.mockResolvedValueOnce({
      id: "action-noop-stale",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Already current",
      status: "OPEN",
      version: 2,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-noop-stale",
      title: "Already current",
      expectedVersion: 1,
    })).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });

    expect(prismaMock.$executeRaw).toHaveBeenCalledWith(expect.anything(), "Action:action-noop-stale");
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.action.findUnique.mock.invocationCallOrder[0]);
    expect(prismaMock.action.update).not.toHaveBeenCalled();
    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(appendEvents).not.toHaveBeenCalled();
  });

  it("rejects 0, negative, or fractional expectedVersion as invalid input even on no-op", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      title: "Follow up",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });

    const { updateAction } = await import("./actions");
    for (const invalidVersion of [0, -1, 1.5]) {
      await expect(updateAction(actor, {
        workspaceId: "workspace-1",
        actionId: "action-1",
        expectedVersion: invalidVersion,
      })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_INPUT",
      });
    }

    expect(prismaMock.action.update).not.toHaveBeenCalled();
    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
  });

  it("requires a completion note when completing an action", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      status: "COMPLETED",
      completedVia: "   ",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prismaMock.action.update).not.toHaveBeenCalled();
  });

  it("links completion evidence when completing an action", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "IN_PROGRESS",
      version: 1,
      assigneeMemberId: "member-2",
      completedVia: null,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "COMPLETED",
      version: 1,
      completedVia: "Delivered and checked.",
    });
    prismaMock.document.findMany.mockResolvedValue([{ id: "doc-1" }]);
    prismaMock.workItemEvidence.createMany.mockResolvedValue({ count: 1 });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      status: "COMPLETED",
      completedVia: " Delivered and checked. ",
      evidenceDocumentIds: ["doc-1", "doc-1"],
    })).resolves.toMatchObject({
      id: "action-1",
      status: "COMPLETED",
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-1" }),
      data: expect.objectContaining({
        status: "COMPLETED",
        completedVia: "Delivered and checked.",
      }),
    }));
    expect(prismaMock.document.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        archivedAt: null,
        id: { in: ["doc-1"] },
      },
      select: { id: true },
    });
    expect(prismaMock.workItemEvidence.createMany).toHaveBeenCalledWith({
      data: [{
        workspaceId: "workspace-1",
        entityType: "Action",
        entityId: "action-1",
        documentId: "doc-1",
        purpose: "completion_evidence",
      }],
      skipDuplicates: true,
    });
  });

  it("allows a draft action to move directly to completed with a completion note", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "DRAFT",
      version: 1,
      assigneeMemberId: "member-2",
      completedVia: null,
      isPrivate: true,
      publishedAt: null,
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      status: "COMPLETED",
      completedVia: "Done from draft.",
      isPrivate: false,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      status: "COMPLETED",
      completedVia: " Done from draft. ",
    })).resolves.toMatchObject({
      id: "action-1",
      status: "COMPLETED",
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-1" }),
      data: expect.objectContaining({
        status: "COMPLETED",
        isPrivate: false,
        publishedAt: expect.any(Date),
        completedVia: "Done from draft.",
      }),
    }));
  });

  it("blocks non-managers from editing another member's draft action", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
      archivedAt: null,
    });
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      role: "MEMBER",
      isActive: true,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction({
      kind: "user",
      user: {
        id: "user-2",
        email: "other@example.com",
        displayName: "Other",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Changed",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });

    expect(prismaMock.action.update).not.toHaveBeenCalled();
  });

  it("rejects hidden, missing, archived, or cross-workspace linked proposals before creating an action", async () => {
    prismaMock.proposal.findFirst.mockResolvedValueOnce(null);

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Follow up",
      proposalId: "proposal-missing",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    expect(prismaMock.proposal.findFirst).toHaveBeenCalledWith({
      where: {
        id: "proposal-missing",
        workspaceId: "workspace-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
        ],
      },
      select: { id: true },
    });
    expect(prismaMock.action.create).not.toHaveBeenCalled();
  });

  it("creates checklist items after verifying action edit access", async () => {
    prismaMock.action.findFirst.mockResolvedValueOnce({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      status: "OPEN",
      version: 1,
      archivedAt: null,
      isPrivate: false,
      assigneeMemberId: null,
    });
    prismaMock.actionChecklistItem.findFirst.mockResolvedValueOnce({ sortOrder: 2 });
    prismaMock.actionChecklistItem.create.mockResolvedValueOnce({
      id: "checklist-1",
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Call the supplier",
      sortOrder: 3,
    });

    const { createActionChecklistItem } = await import("./actions");
    await expect(createActionChecklistItem(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: " Call the supplier ",
    })).resolves.toMatchObject({
      id: "checklist-1",
      title: "Call the supplier",
      sortOrder: 3,
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "action-1",
        workspaceId: "workspace-1",
        archivedAt: null,
        status: "OPEN",
        isPrivate: false,
        version: 1,
      }),
      data: { updatedAt: expect.any(Date) },
    });
    expect(prismaMock.actionChecklistItem.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace-1",
        actionId: "action-1",
        title: "Call the supplier",
        sortOrder: 3,
      },
    });
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.checklist_item.created",
      entityId: "action-1",
    }));
    expect(appendEvents).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        type: "action.checklist_item.created",
        aggregateId: "action-1",
      }),
    ]);
  });

  it("resumes a checklist add-on without inserting its completed item again", async () => {
    const editable = {
      id: "action-1", workspaceId: "workspace-1", authorUserId: "user-1", status: "OPEN",
      version: 1, archivedAt: null, isPrivate: false, assigneeMemberId: null,
    };
    const item = { id: "stable-item", workspaceId: "workspace-1", actionId: "action-1", title: "Call supplier", sortOrder: 0 };
    prismaMock.action.findFirst.mockResolvedValue(editable);
    prismaMock.actionChecklistItem.create.mockResolvedValue(item);
    prismaMock.actionChecklistItem.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(item);

    const { createActionChecklistItem } = await import("./actions");
    const params = { workspaceId: "workspace-1", actionId: "action-1", title: "Call supplier", idempotencyId: "stable-item" };
    await expect(createActionChecklistItem(actor, params)).resolves.toEqual(item);
    await expect(createActionChecklistItem(actor, params)).resolves.toEqual(item);
    expect(prismaMock.actionChecklistItem.create).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it("marks checklist items complete with the acting user", async () => {
    prismaMock.actionChecklistItem.findFirst.mockResolvedValueOnce({
      id: "checklist-1",
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Call the supplier",
      completedAt: null,
    });
    prismaMock.action.findFirst.mockResolvedValueOnce({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      status: "IN_PROGRESS",
      version: 1,
      archivedAt: null,
      isPrivate: false,
      assigneeMemberId: null,
    });
    prismaMock.actionChecklistItem.update.mockResolvedValueOnce({
      id: "checklist-1",
      title: "Call the supplier",
      completedAt: new Date("2026-07-20T10:00:00.000Z"),
    });

    const { updateActionChecklistItem } = await import("./actions");
    await expect(updateActionChecklistItem(actor, {
      workspaceId: "workspace-1",
      checklistItemId: "checklist-1",
      completed: true,
    })).resolves.toMatchObject({
      id: "checklist-1",
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "action-1",
        workspaceId: "workspace-1",
        archivedAt: null,
        status: "IN_PROGRESS",
        isPrivate: false,
        version: 1,
      }),
      data: { updatedAt: expect.any(Date) },
    });
    expect(prismaMock.actionChecklistItem.update).toHaveBeenCalledWith({
      where: { id: "checklist-1" },
      data: expect.objectContaining({
        completedAt: expect.any(Date),
        completedBy: { connect: { id: "user-1" } },
      }),
    });
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.checklist_item.updated",
      meta: expect.objectContaining({
        fields: ["completed"],
      }),
    }));
  });

  it("deletes checklist items after verifying action edit access", async () => {
    prismaMock.actionChecklistItem.findFirst.mockResolvedValueOnce({
      id: "checklist-1",
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Call the supplier",
    });
    prismaMock.action.findFirst.mockResolvedValueOnce({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      status: "OPEN",
      version: 1,
      archivedAt: null,
      isPrivate: false,
      assigneeMemberId: null,
    });
    prismaMock.actionChecklistItem.delete.mockResolvedValueOnce({ id: "checklist-1" });

    const { deleteActionChecklistItem } = await import("./actions");
    await expect(deleteActionChecklistItem(actor, {
      workspaceId: "workspace-1",
      checklistItemId: "checklist-1",
    })).resolves.toEqual({ id: "checklist-1" });

    expect(prismaMock.action.update).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "action-1",
        workspaceId: "workspace-1",
        archivedAt: null,
        status: "OPEN",
        isPrivate: false,
        version: 1,
      }),
      data: { updatedAt: expect.any(Date) },
    });
    expect(prismaMock.actionChecklistItem.delete).toHaveBeenCalledWith({ where: { id: "checklist-1" } });
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.checklist_item.deleted",
      entityId: "action-1",
    }));
  });

  it("rejects stale collaborative checklist edits when the action changes before mutation", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-3",
      workspaceId: "workspace-1",
      userId: "user-3",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.action.findFirst.mockResolvedValueOnce({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      status: "OPEN",
      version: 1,
      archivedAt: null,
      isPrivate: false,
      assigneeMemberId: null,
    });
    prismaMock.action.update.mockRejectedValueOnce({ code: "P2025" });

    const { createActionChecklistItem } = await import("./actions");
    await expect(createActionChecklistItem({
      kind: "user",
      user: {
        id: "user-3",
        email: "other@example.com",
        displayName: "Other",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Call the supplier",
    })).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "action-1",
        workspaceId: "workspace-1",
        archivedAt: null,
        status: "OPEN",
        isPrivate: false,
        version: 1,
      }),
      data: { updatedAt: expect.any(Date) },
    });
    expect(prismaMock.actionChecklistItem.create).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(appendEvents).not.toHaveBeenCalled();
  });

  it("links an uploaded reference only to an editable Action in the same workspace", async () => {
    const action = { id: "action-1", workspaceId: "workspace-1", authorUserId: "user-2", status: "OPEN", isPrivate: false, archivedAt: null, duplicateOfActionId: null };
    prismaMock.action.findUnique.mockResolvedValue(action);
    prismaMock.document.findMany.mockResolvedValue([{ id: "doc-1" }]);
    const { attachActionReferenceDocument } = await import("./actions");

    await attachActionReferenceDocument(actor, { workspaceId: "workspace-1", actionId: "action-1", documentId: "doc-1" });

    expect(prismaMock.workItemEvidence.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: "workspace-1", entityType: "Action", entityId: "action-1", documentId: "doc-1", purpose: "reference" }],
      skipDuplicates: true,
    });
  });

  it("rejects Action upload access before linking when the target is private or changes to a draft", async () => {
    const publicAction = { id: "action-1", workspaceId: "workspace-1", authorUserId: "user-2", status: "OPEN", isPrivate: false, archivedAt: null, duplicateOfActionId: null };
    const privateDraft = { ...publicAction, status: "DRAFT", isPrivate: true };
    const { assertCanAttachActionReference, attachActionReferenceDocument } = await import("./actions");
    prismaMock.action.findUnique.mockResolvedValueOnce(privateDraft);
    await expect(assertCanAttachActionReference(actor, { workspaceId: "workspace-1", actionId: "action-1" }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    prismaMock.action.findUnique.mockResolvedValueOnce(publicAction).mockResolvedValueOnce(privateDraft);
    await expect(attachActionReferenceDocument(actor, { workspaceId: "workspace-1", actionId: "action-1", documentId: "doc-1" }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(prismaMock.workItemEvidence.createMany).not.toHaveBeenCalled();
  });

  it("rechecks the admitted public receipt inside the creation transaction", async () => {
    const {isArtifactInputProofReadable} = await import("./source-lineage");
    vi.mocked(isArtifactInputProofReadable).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const {createAction} = await import("./actions");
    const agent = {kind: "agent", workspaceIds: ["workspace-1"]} as any;
    await expect(createAction(agent, {workspaceId: "workspace-1", title: "Public", isPrivate: false,
      assigneeMemberId: "member-2", lineageRoots: [{kind: "BrainSource", id: "input", fingerprint: "current"}]}))
      .rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(isArtifactInputProofReadable).toHaveBeenLastCalledWith(agent, "workspace-1", expect.any(Array), prismaMock);
    expect(prismaMock.action.create).not.toHaveBeenCalled();
    expect(appendEvents).not.toHaveBeenCalled();
  });

  it("records a supplied creation receipt before publishing side effects in the same transaction", async () => {
    const created = { id: "action-proof", workspaceId: "workspace-1", title: "Synthetic action", status: "DRAFT" };
    prismaMock.action.create.mockResolvedValue(created);
    const roots = [{ kind: "BrainSource" as const, id: "synthetic-source", fingerprint: "a".repeat(64) }];
    const { createAction } = await import("./actions");
    await createAction(actor, { workspaceId: "workspace-1", title: created.title, lineageRoots: roots });
    expect(prepareProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: prismaMock,
      capture: expect.objectContaining({ lineageRoots: roots }) }));
    expect(finishProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: prismaMock,
      artifact: { kind: "Action", id: created.id }, content: created }));
    expect(vi.mocked(finishProducerLineage).mock.invocationCallOrder[0]).toBeLessThan(recordAudit.mock.invocationCallOrder[0]);
  });

  it("rejects a stale supplied prompt receipt before creating an Action", async () => {
    const changed = new Error("Synthetic input changed");
    vi.mocked(prepareProducerLineage).mockRejectedValueOnce(changed);
    const { createAction } = await import("./actions");
    await expect(createAction(actor, { workspaceId: "workspace-1", title: "Synthetic action",
      lineageRoots: [{ kind: "BrainSource", id: "source-1", fingerprint: "a".repeat(64) }] })).rejects.toBe(changed);
    expect(prismaMock.action.create).not.toHaveBeenCalled();
    expect(appendEvents).not.toHaveBeenCalled();
  });


  it("withholds unproven checklist rows from both bodies and progress counts", async () => {
    prismaMock.action.findMany.mockResolvedValue([{ id: "action-1" }]);
    prismaMock.action.findFirst.mockResolvedValue({ id: "action-1", workspaceId: "workspace-1" });
    prismaMock.actionChecklistItem.findMany.mockResolvedValue([
      { id: "item-safe", actionId: "action-1", title: "Safe synthetic task", completedAt: null },
      { id: "item-unknown", actionId: "action-1", title: "Unproven synthetic task", completedAt: new Date() },
    ]);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, rows) =>
      new Set(rows.filter((row) => kind !== "ActionChecklistItem" || row.id === "item-safe").map((row) => row.id)));
    const { listActions, listActionChecklistItems } = await import("./actions");
    await expect(listActions(actor, "workspace-1")).resolves.toMatchObject({
      items: [{ id: "action-1", checklistItemCount: 1, checklistCompletedCount: 0 }],
    });
    await expect(listActionChecklistItems(actor, { workspaceId: "workspace-1", actionId: "action-1" }))
      .resolves.toEqual([expect.objectContaining({ id: "item-safe" })]);
  });

  it.each(["list", "detail"] as const)("keeps a public action %s body while withholding unrelated restricted joins", async (surface) => {
    const publicAction = {
      id: "public-original", workspaceId: "workspace-1", title: "Public work", bodyMd: "Independent original body",
      authorUserId: "departed-user", author: { id: "departed-user", displayName: "Restricted profile", email: "restricted@example.test" },
      assigneeMemberId: "departed-member", assigneeMember: { id: "departed-member", userId: "departed-user",
        user: { id: "departed-user", displayName: "Restricted profile", email: "restricted@example.test" } },
      circleId: "restricted-circle", circle: { id: "restricted-circle", name: "Private-derived circle" },
      proposalId: null, proposal: null,
    };
    prismaMock.action.findMany.mockResolvedValue([publicAction]);
    prismaMock.action.findFirst.mockResolvedValue(publicAction);
    const { listActions, getAction } = await import("./actions");
    const read = async () => surface === "list" ? (await listActions(actor, "workspace-1")).items[0]
      : getAction(actor, { workspaceId: "workspace-1", actionId: publicAction.id });
    expect(await read()).toMatchObject({ author: publicAction.author, assigneeMember: publicAction.assigneeMember, circle: publicAction.circle });
    vi.mocked(captureArtifactInputProof).mockImplementation(async (reader, workspaceId, inputs) => {
      expect(reader).toBe(actor); expect(workspaceId).toBe("workspace-1");
      if (inputs.some((input) => input.kind === "Circle")) throw new AppError(409, "UNKNOWN_LINEAGE", "Unknown circle inputs.");
      throw new AppError(403, "SOURCE_RESTRICTED", "Membership withdrawn.");
    });
    const output = await read();
    expect(output).toMatchObject({ id: publicAction.id, title: publicAction.title, bodyMd: publicAction.bodyMd,
      authorUserId: null, author: { id: "", displayName: null, email: "" }, assigneeMemberId: null, assigneeMember: null, circleId: null, circle: null });
    expect(JSON.stringify(output)).not.toMatch(/Restricted profile|restricted@example|Private-derived circle|departed-user|departed-member|restricted-circle/);
  });

});
