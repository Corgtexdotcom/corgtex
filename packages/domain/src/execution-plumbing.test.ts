import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, captureImmutableArtifactInputProof, readableArtifactIds, isArtifactInputProofReadable, isArtifactInputProofPubliclyShareable, type LineageRoot } from "./source-lineage";
import { prepareProducerLineage, finishProducerLineage } from "./producer-lineage";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    member: { findFirst: vi.fn() },
    workspace: {
      findUnique: vi.fn(),
    },
    executionRequest: {
      create: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    executionResult: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    action: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    tension: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    proposal: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    meeting: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    brainArticle: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    buildArtifact: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    crmCommunicationSuggestion: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    crmConversation: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

const requireWorkspaceMembership = vi.fn();
const actorUserIdForWorkspace = vi.fn();
const recordAudit = vi.fn();
const createAction = vi.fn();
const createTension = vi.fn();
const createProposal = vi.fn();
const createMeeting = vi.fn();
const createArticle = vi.fn();
const upsertBuildArtifact = vi.fn();
const markCommunicationSuggestionSent = vi.fn();
const failCommunicationSuggestion = vi.fn();
const createConversationMessage = vi.fn();
const lockActiveCommunicationSuggestion = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  actorUserIdForWorkspace,
  requireWorkspaceMembership,
}));

vi.mock("./audit-trail", () => ({
  recordAudit,
}));

vi.mock("./actions", () => ({ createAction }));
vi.mock("./tensions", () => ({ createTension }));
vi.mock("./proposals", () => ({ createProposal }));
vi.mock("./meetings", () => ({ createMeeting }));
vi.mock("./brain", () => ({ createArticle }));
vi.mock("./build-artifacts", () => ({ upsertBuildArtifact }));
vi.mock("./crm", () => ({
  markCommunicationSuggestionSent,
  failCommunicationSuggestion,
  createConversationMessage,
  lockActiveCommunicationSuggestion,
}));
vi.mock("./artifact-commit-preflight", () => ({
  lockArtifactReadAuthorityRows: vi.fn(async () => undefined),
  prepareArtifactCommitPreflight: vi.fn(async () => ({})),
  withArtifactCommitPreflight: vi.fn(async (_actor, _workspaceId, _tx, _roots, _token, work, options) => {
    await options?.beforeSourceEpochs();
    return work();
  }),
}));
vi.mock("./artifact-source-commit", () => ({
  prepareArtifactSourceCommit: vi.fn(async () => ({})),
  withArtifactSourceCommit: vi.fn(async (_actor, _workspaceId, _tx, _roots, _options, _token, _owner, work) => work()),
}));
vi.mock("./artifact-input-snapshot-allocations", () => ({
  withArtifactInputSnapshotAllocations: vi.fn(async (_actor, _workspaceId, _tx, _allocations, work) => work()),
}));
vi.mock("./source-lineage", () => ({
  inspectStoredArtifactInputDependencies: vi.fn(async (_db, _ws, roots) => ({ complete: true, roots })),
  sealArtifactInputActor: (actor: unknown) => actor,
  assertArtifactInputWriteFence: vi.fn(async () => undefined),
  lineageContentFingerprint: (_kind: string, row: Record<string, unknown>) => JSON.stringify(Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== "results").sort(([left], [right]) => left.localeCompare(right)))),
  captureArtifactInputProof: vi.fn(), captureArtifactInputSnapshotProof: vi.fn(),
  captureImmutableArtifactInputProof: vi.fn(), readableArtifactIds: vi.fn(),
  isArtifactInputProofReadable: vi.fn(), isArtifactInputProofPubliclyShareable: vi.fn(),
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({ value: await read(), heads: new Map() }),
  mergeLineageInputRoot: (_previous: unknown, root: unknown) => root,
  withArtifactCountReleaseSnapshot: async (_actor: unknown, _ws: unknown, _roots: unknown, remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => { await remote(); return finish(prismaMock); },
}));
vi.mock("./producer-lineage", () => ({ prepareProducerLineage: vi.fn(), finishProducerLineage: vi.fn() }));

const directSuggestionRoot = { kind: "CrmCommunicationSuggestion" as const, id: "suggestion-1", fingerprint: "a".repeat(64) };
const publicPromptRoot = { kind: "Document" as const, id: "source-1", fingerprint: "b".repeat(64) };
const suggestionSnapshotRoot = { kind: "ArtifactInputSnapshot" as const, id: "suggestion-snapshot", fingerprint: "c".repeat(64) };

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

const agentActor: AppActor = {
  kind: "agent",
  authProvider: "credential",
  credentialId: "cred-1",
  label: "OpenWork",
  workspaceIds: ["workspace-1"],
  scopes: ["execution:read", "execution:write", "workspace:read", "actions:read", "actions:write", "relationships:read", "relationships:write"],
};

const otherAgentActor: AppActor = {
  ...agentActor,
  credentialId: "cred-other",
  label: "Other AI workspace",
};

const workspace = {
  id: "workspace-1",
  slug: "acme",
  name: "Acme",
  description: "Self-managed team",
};

function communicationSuggestionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "suggestion-1",
    workspaceId: "workspace-1",
    status: "SUGGESTED",
    channel: "EMAIL",
    title: "Send pilot follow-up",
    subject: "Pilot follow-up",
    bodyMd: "Thanks for the call.",
    recipientEmail: "buyer@example.com",
    recipientName: "Buyer",
    source: "agent_suggestion",
    accountId: "account-1",
    contactId: "contact-1",
    dealId: "deal-1",
    activityId: "activity-1",
    account: {
      id: "account-1",
      name: "Acme Buyers",
      slug: "acme-buyers",
      domain: "example.com",
      relationshipType: "PROSPECT",
      lifecycleStage: "PILOT",
    },
    contact: {
      id: "contact-1",
      name: "Buyer",
      email: "buyer@example.com",
      company: "Acme Buyers",
      title: "Founder",
    },
    deal: {
      id: "deal-1",
      title: "Pilot",
      stage: "PROPOSAL",
      valueCents: 2500000,
      currency: "USD",
    },
    activity: {
      id: "activity-1",
      title: "Follow up",
      type: "TASK",
      dueAt: new Date("2026-06-03T10:00:00.000Z"),
      completedAt: null,
    },
    ...overrides,
  };
}

function requestFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "request-1",
    workspaceId: "workspace-1",
    createdByUserId: "user-1",
    agentCredentialId: "cred-1",
    provider: "OPENWORK",
    status: "PENDING",
    goal: "Draft launch follow-up",
    actorJson: null,
    contextJson: null,
    allowedScopes: ["execution:read", "execution:write", "actions:write"],
    policyConstraintsJson: null,
    expectedOutputJson: null,
    approvalRule: "Draft only",
    writebackTargetType: "ACTION",
    writebackTargetId: null,
    writebackTargetLabel: "New action",
    packetJson: null,
    idempotencyKey: "req-key",
    claimedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    createdAt: new Date("2026-06-02T10:00:00.000Z"),
    updatedAt: new Date("2026-06-02T10:00:00.000Z"),
    results: [],
    ...overrides,
    ...(overrides.writebackTargetType === "CRM_COMMUNICATION" && overrides.contextJson === undefined
      ? { contextJson: { __crmInputReceipt: { version: 1, roots: [suggestionSnapshotRoot, publicPromptRoot] } } } : {}),
  };
}

describe("execution plumbing domain", () => {
  let lastCreatedRequestData: Record<string, unknown> | null;
  let lastCreatedResultData: Record<string, unknown> | null;

  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.$queryRaw.mockImplementation(async (sql, ...values) => sql.join("").includes('SELECT * FROM "ExecutionRequest"')
      ? [await prismaMock.executionRequest.findFirst({ where: { id: values[0], workspaceId: values[1], agentCredentialId: "cred-1" } })].filter(Boolean) : []);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspace, _kind, rows) => new Set(rows.map((row) => row.id)));
    vi.mocked(captureImmutableArtifactInputProof).mockImplementation(async (_actor, _workspace, roots) => [...roots]);
    prismaMock.executionResult.findMany.mockResolvedValue([]);
    vi.mocked(captureArtifactInputProof).mockImplementation(async (_actor, _workspaceId, inputs) => inputs.flatMap<LineageRoot>((input) =>
      input.kind === "CrmCommunicationSuggestion" ? [{ ...directSuggestionRoot, id: input.id }, publicPromptRoot]
        : [{ kind: input.kind, id: input.id, fingerprint: "d".repeat(64) }]));
    vi.mocked(captureArtifactInputSnapshotProof).mockResolvedValue([suggestionSnapshotRoot, publicPromptRoot]);
    vi.mocked(isArtifactInputProofReadable).mockResolvedValue(true);
    vi.mocked(isArtifactInputProofPubliclyShareable).mockResolvedValue(true);
    vi.mocked(prepareProducerLineage).mockResolvedValue({ mode: "ADVANCE", before: {}, allowSystemTransition: true });
    vi.mocked(finishProducerLineage).mockResolvedValue(false);
    lockActiveCommunicationSuggestion.mockResolvedValue(communicationSuggestionFixture());
    lastCreatedRequestData = null;
    lastCreatedResultData = null;
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.workspace.findUnique.mockResolvedValue(workspace);
    prismaMock.member.findFirst.mockImplementation(async ({ where }) => {
      const labels: Record<string, { displayName: string | null; email: string }> = {
        "member-assignee": { displayName: "Assignee", email: "assignee@example.com" },
        "member-responsible": { displayName: "Responsible", email: "responsible@example.com" },
        "member-raiser": { displayName: null, email: "raiser@example.com" }, "member-owner": { displayName: "Owner", email: "owner@example.com" },
      };
      return labels[where.id] ? { id: where.id, workspaceId: where.workspaceId, isActive: true, user: { id: `user-${where.id}`, ...labels[where.id] } } : null;
    });
    prismaMock.executionRequest.findFirst.mockImplementation(async () => requestFixture(lastCreatedRequestData ?? {}));
    prismaMock.executionRequest.findUnique.mockResolvedValue(null);
    prismaMock.executionResult.findUnique.mockResolvedValue(null);
    prismaMock.executionRequest.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      lastCreatedRequestData = data;
      return requestFixture(data);
    });
    prismaMock.executionRequest.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => requestFixture({
      ...(lastCreatedRequestData ?? {}),
      ...data,
    }));
    prismaMock.executionRequest.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.executionResult.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      lastCreatedResultData = data;
      return {
        id: "result-1",
        submittedAt: new Date("2026-06-02T10:10:00.000Z"),
        createdAt: new Date("2026-06-02T10:10:00.000Z"),
        updatedAt: new Date("2026-06-02T10:10:00.000Z"),
        ...data,
      };
    });
    prismaMock.executionResult.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "result-1",
      workspaceId: "workspace-1",
      executionRequestId: "request-1",
      submittedByUserId: null,
      agentCredentialId: "cred-1",
      status: "SUBMITTED",
      idempotencyKey: "result-key",
      targetType: "ACTION",
      targetId: null,
      outputJson: { title: "Follow up" },
      artifactJson: null,
      errorMessage: null,
      writebackEntityType: null,
      writebackEntityId: null,
      submittedAt: new Date("2026-06-02T10:10:00.000Z"),
      acceptedAt: null,
      rejectedAt: null,
      createdAt: new Date("2026-06-02T10:10:00.000Z"),
      updatedAt: new Date("2026-06-02T10:10:00.000Z"),
      ...(lastCreatedResultData ?? {}),
      ...data,
    }));
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1", workspaceId: "workspace-1", userId: "user-1", role: "ADMIN", isActive: true });
    actorUserIdForWorkspace.mockResolvedValue("user-1");
    recordAudit.mockResolvedValue({ id: "audit-1" });
    createAction.mockResolvedValue({ id: "action-new", status: "DRAFT" });
    prismaMock.crmCommunicationSuggestion.findFirst.mockResolvedValue(communicationSuggestionFixture());
    prismaMock.crmCommunicationSuggestion.findMany.mockResolvedValue([communicationSuggestionFixture()]);
    prismaMock.crmCommunicationSuggestion.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...communicationSuggestionFixture(),
      ...data,
    }));
    prismaMock.crmConversation.findFirst.mockResolvedValue({ id: "conversation-1" });
    prismaMock.crmConversation.findUnique.mockResolvedValue({ id: "conversation-1", workspaceId: "workspace-1",
      accountId: "account-1", contactId: "contact-1", dealId: "deal-1" });
    markCommunicationSuggestionSent.mockResolvedValue({ id: "suggestion-1", status: "SENT", accountId: "account-1" });
    failCommunicationSuggestion.mockResolvedValue({ id: "suggestion-1", status: "FAILED", accountId: "account-1" });
    createConversationMessage.mockResolvedValue({ id: "message-1" });
    lockActiveCommunicationSuggestion.mockResolvedValue(communicationSuggestionFixture());
  });

  it("normalizes write-back target aliases", async () => {
    const { normalizeExecutionTargetType } = await import("./execution-plumbing");

    expect(normalizeExecutionTargetType("brain")).toBe("BRAIN_ARTICLE");
    expect(normalizeExecutionTargetType("build-artifact")).toBe("BUILD_ARTIFACT");
    expect(normalizeExecutionTargetType("comments")).toBe("COMMENT");
    expect(normalizeExecutionTargetType("email-suggestion")).toBe("CRM_COMMUNICATION");
    expect(() => normalizeExecutionTargetType("spreadsheet")).toThrow("Unsupported write-back target type");
  });

  it("creates redacted execution packets with target-derived scopes", async () => {
    const { createExecutionRequest } = await import("./execution-plumbing");

    const created = await createExecutionRequest(actor, {
      workspaceId: "workspace-1",
      provider: "openwork",
      goal: "Draft launch follow-up",
      actor: { displayName: "User", accessToken: "secret-token" },
      context: { brainArticle: { title: "Private runbook" } },
      lineageRoots: [publicPromptRoot],
      writebackTargetType: "action",
      idempotencyKey: "req-key",
    });

    expect(created).toMatchObject({
      id: "request-1",
      provider: "OPENWORK",
      writebackTarget: { type: "ACTION" },
    });
    expect(created).not.toHaveProperty("packet");
    expect(created).not.toHaveProperty("context");
    expect(prismaMock.executionRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorJson: expect.objectContaining({ accessToken: "[redacted]" }),
        contextJson: expect.objectContaining({ brainArticle: { title: "Private runbook" } }),
        allowedScopes: expect.arrayContaining(["execution:read", "execution:write", "actions:read", "actions:write"]),
      }),
    }));
    expect(prismaMock.executionRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        packetJson: expect.objectContaining({
          id: "request-1",
          actor: expect.objectContaining({ accessToken: "[redacted]" }),
        }),
      }),
    }));
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "execution_request.created",
      entityType: "ExecutionRequest",
    }));
  });

  it("requires target scopes when creating scoped execution requests", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(null);
    const limitedAgent: AppActor = {
      ...agentActor,
      scopes: ["execution:write"],
    };

    const { createExecutionRequest } = await import("./execution-plumbing");
    await expect(createExecutionRequest(limitedAgent, {
      workspaceId: "workspace-1",
      provider: "openwork",
      goal: "Draft launch follow-up",
      writebackTargetType: "ACTION",
      writebackTargetId: "action-1",
      idempotencyKey: "limited-create",
    })).rejects.toThrow("Agent credential is missing the required scope: actions:read.");

    expect(prismaMock.action.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.executionRequest.create).not.toHaveBeenCalled();
  });

  it("creates CRM communication packets and records the execution request on the suggestion", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(null);

    const { createExecutionRequest } = await import("./execution-plumbing");
    const created = await createExecutionRequest(agentActor, {
      workspaceId: "workspace-1",
      provider: "openwork",
      goal: "Send the relationship follow-up externally",
      writebackTargetType: "communication-suggestion",
      lineageRoots: [publicPromptRoot],
      writebackTargetId: "suggestion-1",
      idempotencyKey: "crm-request-key",
    });

    expect(created.writebackTarget).toMatchObject({
      type: "CRM_COMMUNICATION",
      id: "suggestion-1",
      label: "Pilot follow-up",
    });
    expect(prismaMock.executionRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        allowedScopes: expect.arrayContaining(["relationships:read", "relationships:write"]),
        contextJson: expect.objectContaining({
          relationshipCommunication: expect.objectContaining({
            id: "suggestion-1",
            subject: "Pilot follow-up",
            account: expect.objectContaining({ id: "account-1" }),
          }),
          executionMode: expect.objectContaining({ emailSentByCorgtex: false }),
        }),
      }),
    }));
    expect(prismaMock.crmCommunicationSuggestion.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "suggestion-1" },
      data: expect.objectContaining({
        status: "REQUESTED",
        externalRequestId: "request-1",
        sentAt: null,
        failureReason: null,
      }),
    }));
    expect(lockActiveCommunicationSuggestion).toHaveBeenCalledWith(prismaMock, {
      workspaceId: "workspace-1",
      suggestionId: "suggestion-1",
      expectedLinks: { accountId: "account-1", contactId: "contact-1", dealId: "deal-1", activityId: "activity-1" },
    });
    expect(lockActiveCommunicationSuggestion.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.executionRequest.create.mock.invocationCallOrder[0]!);
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), agentActor, expect.objectContaining({
      action: "crm.communication_suggestion.requested",
      entityType: "CrmCommunicationSuggestion",
      entityId: "suggestion-1",
    }));
  });

  it("does not write an execution request when the suggestion closure changes under lock", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(null);
    lockActiveCommunicationSuggestion.mockRejectedValueOnce(Object.assign(new Error("changed"), { code: "CRM_LINK_CLOSURE_CHANGED" }));
    const { createExecutionRequest } = await import("./execution-plumbing");
    await expect(createExecutionRequest(agentActor, { workspaceId: "workspace-1", goal: "Send", provider: "openwork",
      lineageRoots: [publicPromptRoot],
      writebackTargetType: "CRM_COMMUNICATION", writebackTargetId: "suggestion-1" })).rejects.toMatchObject({ code: "CRM_LINK_CLOSURE_CHANGED" });
    expect(prismaMock.executionRequest.create).not.toHaveBeenCalled();
    expect(prismaMock.crmCommunicationSuggestion.update).not.toHaveBeenCalled();
  });

  it("returns an existing execution request on concurrent idempotency create races", async () => {
    prismaMock.executionRequest.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(requestFixture({ id: "request-race", results: [] }));
    prismaMock.$transaction.mockRejectedValueOnce({ code: "P2002" });
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({ id: "request-race" }));

    const { createExecutionRequest } = await import("./execution-plumbing");
    const existing = await createExecutionRequest(actor, {
      workspaceId: "workspace-1",
      provider: "openwork",
      goal: "Draft launch follow-up",
      writebackTargetType: "ACTION",
      idempotencyKey: "race-key",
    });

    expect(existing).toMatchObject({ id: "request-race" });
    expect(prismaMock.executionRequest.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { workspaceId_idempotencyKey: { workspaceId: "workspace-1", idempotencyKey: "race-key" } },
    }));
  });

  it("returns existing execution requests before revalidating stale targets", async () => {
    prismaMock.executionRequest.findUnique.mockResolvedValueOnce(requestFixture({
      id: "request-existing",
      writebackTargetId: "action-old",
      results: [],
    }));

    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({ id: "request-existing", writebackTargetId: "action-old" }));
    const { createExecutionRequest } = await import("./execution-plumbing");
    const existing = await createExecutionRequest(actor, {
      workspaceId: "workspace-1",
      provider: "openwork",
      goal: "",
      writebackTargetType: "action",
      writebackTargetId: "archived-action",
      idempotencyKey: "req-key",
    });

    expect(existing).toMatchObject({ id: "request-existing" });
    expect(prismaMock.action.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.executionRequest.create).not.toHaveBeenCalled();
  });

  it("scopes agent request access to the creating credential", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(null);

    const { getExecutionRequest, listExecutionRequests } = await import("./execution-plumbing");
    await expect(getExecutionRequest(otherAgentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
    })).rejects.toThrow("Execution request not found.");

    expect(prismaMock.executionRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "request-1",
        workspaceId: "workspace-1",
        agentCredentialId: "cred-other",
      }),
    }));

    prismaMock.executionRequest.findMany.mockResolvedValueOnce([]);
    await listExecutionRequests(agentActor, { workspaceId: "workspace-1" });
    expect(prismaMock.executionRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        agentCredentialId: "cred-1",
      }),
    }));
  });

  it("returns a same-key terminal result after losing the request claim", async () => {
    prismaMock.executionRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({ status: "COMPLETED" }));
    prismaMock.executionResult.findUnique.mockResolvedValueOnce({
      id: "result-existing",
      executionRequestId: "request-1",
      status: "ACCEPTED",
      idempotencyKey: "same-key",
      targetType: "ACTION",
      targetId: null,
      outputJson: { title: "Follow up" },
      artifactJson: null,
      errorMessage: null,
      writebackEntityType: "Action",
      writebackEntityId: "action-1",
      submittedAt: new Date("2026-06-02T10:10:00.000Z"),
      acceptedAt: new Date("2026-06-02T10:10:00.000Z"),
      rejectedAt: null,
    });

    const { submitExecutionResult } = await import("./execution-plumbing");
    const result = await submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "same-key",
      output: { title: "Follow up" },
    });

    expect(result).toMatchObject({ id: "result-existing", writeback: { entityId: "action-1" } });
    expect(prismaMock.executionRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "request-1",
        workspaceId: "workspace-1",
        agentCredentialId: "cred-1",
      }),
    }));
    expect(createAction).not.toHaveBeenCalled();
    expect(prismaMock.executionResult.create).not.toHaveBeenCalled();
    expect(prismaMock.executionRequest.update).not.toHaveBeenCalled();
  });

  it("does not return duplicate results before workspace-scoped request authorization", async () => {
    prismaMock.executionRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(null);
    prismaMock.executionResult.findUnique.mockResolvedValueOnce({
      id: "result-other",
      executionRequestId: "request-1",
      status: "ACCEPTED",
      idempotencyKey: "same-key",
      targetType: "ACTION",
      targetId: null,
      outputJson: { title: "Other workspace" },
      artifactJson: null,
      errorMessage: null,
      writebackEntityType: "Action",
      writebackEntityId: "action-other",
      submittedAt: new Date("2026-06-02T10:10:00.000Z"),
      acceptedAt: new Date("2026-06-02T10:10:00.000Z"),
      rejectedAt: null,
    });

    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "same-key",
      output: { title: "Follow up" },
    })).rejects.toThrow("Execution request not found.");

    expect(prismaMock.executionResult.findUnique).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace write-back targets before storing a result", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({ writebackTargetId: "action-other" }));
    prismaMock.action.findFirst.mockResolvedValueOnce(null);

    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "result-key",
      output: { title: "Follow up" },
    })).rejects.toThrow("Action write-back target not found");

    expect(prismaMock.executionResult.create).not.toHaveBeenCalled();
    expect(createAction).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace CRM communication targets before creating requests", async () => {
    prismaMock.crmCommunicationSuggestion.findFirst.mockResolvedValueOnce(null);

    const { createExecutionRequest } = await import("./execution-plumbing");
    await expect(createExecutionRequest(actor, {
      workspaceId: "workspace-1",
      provider: "openwork",
      goal: "Send the relationship follow-up externally",
      writebackTargetType: "CRM_COMMUNICATION",
      writebackTargetId: "suggestion-other",
      idempotencyKey: "crm-cross-target",
    })).rejects.toThrow("CRM communication write-back target not found.");

    expect(prismaMock.executionRequest.create).not.toHaveBeenCalled();
    expect(prismaMock.crmCommunicationSuggestion.update).not.toHaveBeenCalled();
  });

  it("filters archived-parent CRM suggestions from direct and search target resolution", async () => {
    prismaMock.crmCommunicationSuggestion.findFirst.mockResolvedValueOnce(null);
    const { createExecutionRequest, listWritebackTargets } = await import("./execution-plumbing");
    await expect(createExecutionRequest(actor, { workspaceId: "workspace-1", provider: "openwork", goal: "Send",
      writebackTargetType: "CRM_COMMUNICATION", writebackTargetId: "suggestion-1" }))
      .rejects.toThrow("CRM communication write-back target not found.");
    await listWritebackTargets(agentActor, { workspaceId: "workspace-1", targetTypes: ["CRM_COMMUNICATION"] });
    for (const call of [prismaMock.crmCommunicationSuggestion.findFirst.mock.calls[0],
      prismaMock.crmCommunicationSuggestion.findMany.mock.calls.at(-1)]) {
      expect(call?.[0]?.where).toMatchObject({ AND: expect.arrayContaining([
        { OR: [{ accountId: null }, { account: { archivedAt: null } }] },
      ]) });
    }
  });

  it("applies visibility filters when listing write-back targets", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({ id: "member-1", workspaceId: "workspace-1", userId: "user-1", role: "MEMBER", isActive: true });
    prismaMock.action.findMany.mockResolvedValueOnce([]);

    const { listWritebackTargets } = await import("./execution-plumbing");
    await listWritebackTargets(actor, {
      workspaceId: "workspace-1",
      targetTypes: ["action"],
      query: "launch",
    });

    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
        ],
      }),
    }));
  });

  it("excludes operational build artifacts from execution write-back targets", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValueOnce([]);
    const { createExecutionRequest, listWritebackTargets } = await import("./execution-plumbing");

    await listWritebackTargets(agentActor, {
      workspaceId: "workspace-1",
      targetTypes: ["BUILD_ARTIFACT"],
    });

    expect(prismaMock.buildArtifact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        NOT: {
          repositoryOwner: "corgtexdotcom",
          repositoryName: "corgtex-ops",
          pullRequestNumber: null,
        },
      }),
    }));

    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(null);
    prismaMock.buildArtifact.findFirst.mockResolvedValueOnce(null);
    const buildAgent = { ...agentActor, scopes: [...(agentActor.scopes ?? []), "workspace:write"] };
    await expect(createExecutionRequest(buildAgent, {
      workspaceId: "workspace-1",
      provider: "openwork",
      goal: "Update release evidence",
      writebackTargetType: "BUILD_ARTIFACT",
      writebackTargetId: "artifact-operational",
      idempotencyKey: "ops-artifact-target",
    })).rejects.toThrow("Build artifact write-back target not found.");
    expect(prismaMock.buildArtifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "artifact-operational",
        workspaceId: "workspace-1",
        NOT: {
          repositoryOwner: "corgtexdotcom",
          repositoryName: "corgtex-ops",
          pullRequestNumber: null,
        },
      },
    }));
    expect(prismaMock.executionRequest.create).not.toHaveBeenCalled();
  });

  it("requires content read scopes before returning company context", async () => {
    const { getCompanyContext } = await import("./execution-plumbing");

    await expect(getCompanyContext(agentActor, "workspace-1")).rejects.toThrow("Agent credential is missing the required scope: tensions:read.");

    expect(requireWorkspaceMembership).not.toHaveBeenCalled();
    expect(prismaMock.action.findMany).not.toHaveBeenCalled();
    expect(prismaMock.tension.findMany).not.toHaveBeenCalled();
  });

  it("returns labeled priority and responsibility fields in company context", async () => {
    const contextAgent: AppActor = {
      ...agentActor,
      scopes: [
        "execution:read",
        "workspace:read",
        "actions:read",
        "tensions:read",
        "proposals:read",
        "meetings:read",
        "brain:read",
      ],
    };
    prismaMock.action.findMany.mockResolvedValueOnce([{
      id: "action-1",
      title: "Follow up",
      status: "OPEN",
      priority: 2,
      assigneeMemberId: "member-assignee",
      assigneeMember: { user: { displayName: "Assignee", email: "assignee@example.com" } },
      dueAt: null,
      updatedAt: new Date("2026-06-02T10:00:00.000Z"),
    }]);
    prismaMock.tension.findMany.mockResolvedValueOnce([{
      id: "tension-1",
      title: "No owner",
      status: "OPEN",
      priority: 7,
      assigneeMemberId: "member-responsible",
      assigneeMember: { user: { displayName: "Responsible", email: "responsible@example.com" } },
      raisedByMemberId: "member-raiser",
      raisedByMember: { user: { displayName: null, email: "raiser@example.com" } },
      updatedAt: new Date("2026-06-02T10:00:00.000Z"),
    }]);
    prismaMock.proposal.findMany.mockResolvedValueOnce([{
      id: "proposal-1",
      title: "Clarify ownership",
      summary: null,
      status: "OPEN",
      priority: 1,
      ownerMemberId: "member-owner",
      ownerMember: { user: { displayName: "Owner", email: "owner@example.com" } },
      updatedAt: new Date("2026-06-02T10:00:00.000Z"),
    }]);
    prismaMock.meeting.findMany.mockResolvedValueOnce([]);
    prismaMock.brainArticle.findMany.mockResolvedValueOnce([]);

    const { getCompanyContext } = await import("./execution-plumbing");
    const context = await getCompanyContext(contextAgent, "workspace-1") as {
      recent: {
        actions: Array<Record<string, unknown>>;
        tensions: Array<Record<string, unknown>>;
        proposals: Array<Record<string, unknown>>;
      };
    };

    expect(context.recent.actions[0]).toMatchObject({
      priority: 2,
      priorityLabel: "Important",
      assigneeMemberId: "member-assignee",
      assigneeMemberName: "Assignee",
      assignee: "Assignee",
    });
    expect(context.recent.actions[0]).not.toHaveProperty("assigneeMember");
    expect(context.recent.tensions[0]).toMatchObject({
      priority: 7,
      priorityLabel: "Urgent",
      assigneeMemberId: "member-responsible",
      responsibleMemberId: "member-responsible",
      responsibleMemberName: "Responsible",
      responsiblePerson: "Responsible",
      raisedByMemberId: "member-raiser",
      raisedByMemberName: "raiser@example.com",
      raisedBy: "raiser@example.com",
    });
    expect(context.recent.tensions[0]).not.toHaveProperty("assigneeMember");
    expect(context.recent.tensions[0]).not.toHaveProperty("raisedByMember");
    expect(context.recent.proposals[0]).toMatchObject({
      priority: 1,
      priorityLabel: "Medium",
      ownerMemberId: "member-owner",
      ownerMemberName: "Owner",
      owner: "Owner",
    });
    expect(context.recent.proposals[0]).not.toHaveProperty("ownerMember");
  });

  it("replenishes a filtered recent execution page beyond five thousand hidden candidates", async () => {
    const hidden = Array.from({length:5001},(_,i)=>requestFixture({id:`request-${String(i).padStart(5,"0")}`}));
    const known = requestFixture({id:"request-99999"});
    const rows = [...hidden, known];
    prismaMock.executionRequest.findMany.mockImplementation(async ({where,take}) => rows.filter(row => !where.OR || row.id > where.OR[1].id.gt).slice(0,take));
    prismaMock.executionRequest.findFirst.mockImplementation(async ({where}) => where.id===known.id ? known : null);
    const {listExecutionRequests}=await import("./execution-plumbing");
    expect((await listExecutionRequests(actor,{workspaceId:"workspace-1",status:"pending",take:1})).map(row=>row.id)).toEqual([known.id]);
    expect(prismaMock.executionRequest.findMany).toHaveBeenCalledTimes(51);
    expect(prismaMock.executionRequest.findMany.mock.calls.every(([q])=>q.take===100 && q.where.status==="PENDING"
      && JSON.stringify(q.orderBy)===JSON.stringify([{createdAt:"desc"},{id:"asc"}]))).toBe(true);
  });

  it("replenishes recent company inputs without a corpus cap and preserves coalesced meeting dates", async () => {
    const rows=Array.from({length:5021},(_,i)=>({id:`action-${String(i).padStart(5,"0")}`,title:`Action ${i}`,updatedAt:new Date("2026-06-02"),assigneeMemberId:null}));
    prismaMock.action.findMany.mockImplementation(async ({where,take})=>rows.filter(row=>!where.OR || row.id>where.OR[1].id.gt).slice(0,take));
    const capture=vi.mocked(captureArtifactInputProof).getMockImplementation()!;
    vi.mocked(captureArtifactInputProof).mockImplementation(async (...args)=>{
      if(args[2].some(input=>input.kind==="Action" && input.id < "action-05001")) throw new AppError(409,"UNKNOWN_LINEAGE","Hidden candidate");
      return capture(...args);
    });
    prismaMock.tension.findMany.mockResolvedValue([]);
    prismaMock.proposal.findMany.mockResolvedValue([]);
    prismaMock.brainArticle.findMany.mockResolvedValue([]);
    prismaMock.meeting.findMany.mockResolvedValue([
      {id:"meeting-a",title:"Recorded earlier",recordedAt:new Date("2024-01-01"),updatedAt:new Date("2026-06-01")},
      {id:"meeting-b",title:"Updated fallback",recordedAt:null,updatedAt:new Date("2026-05-01")},
    ]);
    const {getCompanyContext}=await import("./execution-plumbing");
    const context=await getCompanyContext(actor,"workspace-1") as any;
    expect(context.recent.actions.map((row:any)=>row.id)).toEqual(rows.slice(5001).map(row=>row.id));
    expect(context.recent.meetings.map((row:any)=>row.id)).toEqual(["meeting-b","meeting-a"]);
    expect(prismaMock.action.findMany).toHaveBeenCalledTimes(51);
    expect(prismaMock.action.findMany.mock.calls.every(([q])=>q.take===100)).toBe(true);
  });

  it("applies Brain draft visibility when listing article write-back targets", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({ id: "member-1", workspaceId: "workspace-1", userId: "user-1", role: "MEMBER", isActive: true });
    prismaMock.brainArticle.findMany.mockResolvedValueOnce([]);

    const brainAgent = {
      ...agentActor,
      scopes: [...(agentActor.scopes ?? []), "brain:read"],
    };

    const { listWritebackTargets } = await import("./execution-plumbing");
    await listWritebackTargets(brainAgent, {
      workspaceId: "workspace-1",
      targetTypes: ["brain"],
    });

    expect(prismaMock.brainArticle.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: [
          { workspaceId: "workspace-1", archivedAt: null },
          { OR: [{ isPrivate: false }, { isPrivate: true, authority: "DRAFT" }] },
        ],
      },
    }));
  });

  it("rejects result targets outside the execution request allowed scopes", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({
      writebackTargetType: null,
      allowedScopes: ["execution:read", "execution:write"],
    }));

    const broadAgent = {
      ...agentActor,
      scopes: [...(agentActor.scopes ?? []), "proposals:write"],
    };

    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(broadAgent, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "result-key",
      targetType: "PROPOSAL",
      output: { title: "Governance update", bodyMd: "Do the thing." },
    })).rejects.toThrow("Execution request does not allow the required scope: proposals:write.");

    expect(prismaMock.executionResult.create).not.toHaveBeenCalled();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("rejects invalid native output before storing a result shell", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture());

    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "result-key",
      output: { bodyMd: "Missing title" },
    })).rejects.toThrow("Action title is required.");

    expect(prismaMock.executionResult.create).not.toHaveBeenCalled();
    expect(createAction).not.toHaveBeenCalled();
  });

  it("rejects unsupported Brain enum values before storing a result shell", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({
      writebackTargetType: "BRAIN_ARTICLE",
      allowedScopes: ["execution:read", "execution:write", "brain:write"],
    }));

    const brainAgent = {
      ...agentActor,
      scopes: [...(agentActor.scopes ?? []), "brain:write"],
    };

    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(brainAgent, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "result-key",
      output: { title: "Launch runbook", bodyMd: "Steps", type: "unknown" },
    })).rejects.toThrow("Brain article type is unsupported.");

    expect(prismaMock.executionResult.create).not.toHaveBeenCalled();
    expect(createArticle).not.toHaveBeenCalled();
  });

  it("rejects unsupported build artifact enum values before storing a result shell", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({
      writebackTargetType: "BUILD_ARTIFACT",
      allowedScopes: ["execution:read", "execution:write", "workspace:write"],
    }));

    const buildAgent = {
      ...agentActor,
      scopes: [...(agentActor.scopes ?? []), "workspace:write"],
    };

    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(buildAgent, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "result-key",
      output: {
        repositoryOwner: "Corgtexdotcom",
        repositoryName: "corgtex",
        title: "PR 347",
        status: "shipped",
      },
    })).rejects.toThrow("Build artifact status is unsupported.");

    expect(prismaMock.executionResult.create).not.toHaveBeenCalled();
    expect(upsertBuildArtifact).not.toHaveBeenCalled();
  });

  it("rejects packets for cancelled execution requests", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({ status: "CANCELLED" }));

    const { getExecutionPacket } = await import("./execution-plumbing");
    await expect(getExecutionPacket(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
    })).rejects.toThrow("Execution packet is not available for failed or cancelled requests.");

    expect(prismaMock.executionRequest.update).not.toHaveBeenCalled();
    expect(prismaMock.executionRequest.updateMany).not.toHaveBeenCalled();
  });

  it("claims pending packets with a state-scoped update", async () => {
    prismaMock.executionRequest.findFirst
      .mockResolvedValueOnce(requestFixture({ status: "PENDING" }))
      .mockResolvedValueOnce(requestFixture({ status: "PENDING" }));

    const { getExecutionPacket } = await import("./execution-plumbing");
    const packet = await getExecutionPacket(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
    });

    expect(packet).toMatchObject({ id: "request-1", status: "IN_PROGRESS" });
    expect(prismaMock.$queryRaw).toHaveBeenCalled();
    expect(prismaMock.executionRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "request-1" }, data: expect.objectContaining({ status: "IN_PROGRESS" }),
    }));
    expect(finishProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ artifact: { kind: "ExecutionRequest", id: "request-1" } }));
  });

  it("rejects packet claim losers after the pending-state compare-and-swap", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({ status: "PENDING" }))
      .mockResolvedValueOnce(requestFixture({ status: "IN_PROGRESS" }));

    const { getExecutionPacket } = await import("./execution-plumbing");
    await expect(getExecutionPacket(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
    })).rejects.toThrow("Execution packet is no longer available for claiming.");

    expect(prismaMock.executionRequest.findFirst).toHaveBeenCalledTimes(2);
  });

  it("creates draft native records and audits accepted results", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture());

    const { submitExecutionResult } = await import("./execution-plumbing");
    const result = await submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "result-key",
      output: {
        title: " Follow up ",
        bodyMd: "Notes",
        apiKey: "secret",
        downloadUrl: "https://example.test/file?access_token=clear-token&ok=1",
      },
      artifacts: [{ log: "Authorization: Bearer clear-token-value" }],
    });

    expect(createAction).toHaveBeenCalledWith(agentActor, expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Follow up",
      bodyMd: "Notes",
      isPrivate: true,
    }));
    expect(result).toMatchObject({
      status: "ACCEPTED",
      writeback: { entityType: "Action", entityId: "action-new" },
    });
    expect(prismaMock.executionResult.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        outputJson: expect.objectContaining({
          apiKey: "[redacted]",
          downloadUrl: "https://example.test/file?access_token=[redacted]&ok=1",
        }),
        artifactJson: [{ log: "Authorization: Bearer [redacted]" }],
      }),
    }));
    expect(prismaMock.executionResult.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        writebackEntityType: "Action",
        writebackEntityId: "action-new",
      }),
    }));
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), agentActor, expect.objectContaining({
      action: "execution_result.submitted",
      entityId: "request-1",
    }));
  });

  it.each([
    ["TENSION", createTension, "Tension", { title: "Copied tension", bodyMd: "Body" }],
    ["PROPOSAL", createProposal, "Proposal", { title: "Copied proposal", bodyMd: "Body" }],
    ["MEETING", createMeeting, "Meeting", { title: "Copied meeting", transcript: "Transcript" }],
    ["BRAIN_ARTICLE", createArticle, "BrainArticle", { title: "Copied article", bodyMd: "Body" }],
  ] as const)("hands %s the actual actor, complete Result receipt and same transaction", async (type, writer, entityType, output) => {
    writer.mockResolvedValueOnce({ id: "native-output" });
    prismaMock.executionRequest.findFirst.mockResolvedValue(requestFixture({ writebackTargetType: type,
      allowedScopes: ["execution:read", "execution:write", type === "TENSION" ? "tensions:write" : type === "PROPOSAL" ? "proposals:write" : type === "MEETING" ? "meetings:write" : "brain:write"] }));
    const { submitExecutionResult } = await import("./execution-plumbing");
    expect(await submitExecutionResult(actor, { workspaceId: "workspace-1", requestId: "request-1", idempotencyKey: "native", lineageRoots: [publicPromptRoot], output }))
      .toMatchObject({ writeback: { entityType, entityId: "native-output" } });
    const call = writer.mock.calls[0]!;
    expect(call[0]).toBe(actor);
    expect(call[1]).not.toHaveProperty("duplicateGuard");
    expect(call[1][type === "BRAIN_ARTICLE" ? "completeInputRoots" : "lineageRoots"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ExecutionResult", id: "result-1" }),
    ]));
    if (type === "TENSION" || type === "PROPOSAL") expect(call[2]).toBe(prismaMock);
    else expect(call[1].tx).toBe(prismaMock);
    if (type === "PROPOSAL") expect(call[1].includeAiSummary).toBe(false);
    if (type === "MEETING") expect(call[1].copied).toBe(true);
  });

  it("marks CRM communication suggestions sent and appends conversation notes from accepted results", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValue(requestFixture({
      status: "IN_PROGRESS",
      writebackTargetType: "CRM_COMMUNICATION",
      writebackTargetId: "suggestion-1",
      allowedScopes: ["execution:read", "execution:write", "relationships:write"],
    }));

    const { submitExecutionResult } = await import("./execution-plumbing");
    const result = await submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "crm-result-key",
      output: {
        sentAt: "2026-06-02T10:30:00.000Z",
        conversationId: "conversation-1",
        conversationBodyMd: "Sent externally via OpenWork.",
      },
    });

    expect(markCommunicationSuggestionSent).toHaveBeenCalledWith(agentActor, expect.objectContaining({
      workspaceId: "workspace-1",
      suggestionId: "suggestion-1",
      sentAt: new Date("2026-06-02T10:30:00.000Z"),
    }), prismaMock);
    expect(createConversationMessage).toHaveBeenCalledWith(agentActor, expect.objectContaining({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      senderType: "SYSTEM",
      senderEmail: undefined,
      bodyMd: "Sent externally via OpenWork.",
    }), prismaMock);
    expect(result).toMatchObject({
      status: "ACCEPTED",
      writeback: { entityType: "CrmCommunicationSuggestion", entityId: "suggestion-1" },
    });
    expect(prismaMock.executionRequest.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(markCommunicationSuggestionSent.mock.invocationCallOrder[0]!);
  });

  it("marks CRM communication suggestions failed when external execution fails", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValue(requestFixture({
      status: "IN_PROGRESS",
      writebackTargetType: "CRM_COMMUNICATION",
      writebackTargetId: "suggestion-1",
      allowedScopes: ["execution:read", "execution:write", "relationships:write"],
    }));

    const { submitExecutionResult } = await import("./execution-plumbing");
    const result = await submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "crm-failed-result-key",
      output: { details: "Mailbox unavailable" },
      errorMessage: "External client could not send the email",
    });

    expect(failCommunicationSuggestion).toHaveBeenCalledWith(agentActor, expect.objectContaining({
      workspaceId: "workspace-1",
      suggestionId: "suggestion-1",
      failureReason: "External client could not send the email",
    }), prismaMock);
    expect(markCommunicationSuggestionSent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "REJECTED",
      writeback: { entityType: "CrmCommunicationSuggestion", entityId: "suggestion-1" },
    });
  });

  it("rejects cross-workspace CRM conversation write-back before storing a result", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({
      status: "IN_PROGRESS",
      writebackTargetType: "CRM_COMMUNICATION",
      writebackTargetId: "suggestion-1",
      allowedScopes: ["execution:read", "execution:write", "relationships:write"],
    }));
    prismaMock.crmConversation.findFirst.mockResolvedValueOnce(null);

    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "crm-cross-conversation-key",
      output: {
        conversationId: "conversation-other",
        conversationBodyMd: "Sent externally.",
      },
    })).rejects.toThrow("CRM conversation write-back target not found.");

    expect(prismaMock.executionResult.create).not.toHaveBeenCalled();
    expect(markCommunicationSuggestionSent).not.toHaveBeenCalled();
    expect(createConversationMessage).not.toHaveBeenCalled();
  });

  it("rolls back CRM execution writeback before execution writes when conversation closure changes", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValue(requestFixture({ status: "IN_PROGRESS",
      writebackTargetType: "CRM_COMMUNICATION", writebackTargetId: "suggestion-1",
      allowedScopes: ["execution:read", "execution:write", "relationships:write"] }));
    createConversationMessage.mockRejectedValueOnce(new Error("Conversation not found."));
    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(agentActor, { workspaceId: "workspace-1", requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "crm-closure-drift", output: { conversationId: "conversation-1" } }))
      .rejects.toThrow("Conversation not found.");
    expect(markCommunicationSuggestionSent).toHaveBeenCalledWith(expect.anything(), expect.anything(), prismaMock);
    expect(lockActiveCommunicationSuggestion.mock.invocationCallOrder[0])
      .toBeLessThan(markCommunicationSuggestionSent.mock.invocationCallOrder[0]!);
    expect(createConversationMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), prismaMock);
    expect(prismaMock.executionResult.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUBMITTED" }) }));
    expect(prismaMock.executionResult.update).not.toHaveBeenCalled();
  });

  it("rolls back CRM writeback when the terminal request write fails", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValue(requestFixture({ status: "IN_PROGRESS",
      writebackTargetType: "CRM_COMMUNICATION", writebackTargetId: "suggestion-1",
      allowedScopes: ["execution:read", "execution:write", "relationships:write"] }));
    prismaMock.executionRequest.update.mockImplementationOnce(async ({ data }) => {
      expect(data.status).toBe("COMPLETED"); throw new Error("terminal write failed");
    });
    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(agentActor, { workspaceId: "workspace-1", requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "crm-terminal-failure", output: {} })).rejects.toThrow("terminal write failed");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(prismaMock.executionRequest.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(markCommunicationSuggestionSent.mock.invocationCallOrder[0]!);
    expect(markCommunicationSuggestionSent).toHaveBeenCalledWith(expect.anything(), expect.anything(), prismaMock);
    expect(prismaMock.executionResult.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: "SUBMITTED", writebackEntityType: null, writebackEntityId: null }) }));
    expect(prismaMock.executionResult.update).toHaveBeenCalled();
  });

  it("fails closed instead of returning a partial CRM idempotency result", async () => {
    prismaMock.executionRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({ status: "RESULT_SUBMITTED" }));
    prismaMock.executionResult.findUnique.mockResolvedValueOnce({ id: "result-partial", executionRequestId: "request-1",
      status: "SUBMITTED", targetType: "CRM_COMMUNICATION" });
    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(agentActor, { workspaceId: "workspace-1", requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "crm-partial", output: {} })).rejects.toThrow("different or incomplete result");
    expect(markCommunicationSuggestionSent).not.toHaveBeenCalled();
  });

  it("accepts failure results without write-back targets", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValue(requestFixture({
      writebackTargetType: null,
      writebackTargetId: null,
      writebackTargetLabel: null,
      allowedScopes: ["execution:read", "execution:write"],
    }));

    const { submitExecutionResult } = await import("./execution-plumbing");
    const result = await submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "result-key",
      output: { details: "Could not reach external client" },
      errorMessage: "OpenWork client disconnected",
    });

    expect(result).toMatchObject({ status: "REJECTED", errorMessage: "OpenWork client disconnected" });
    expect(prismaMock.executionResult.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        targetType: null,
        targetId: null,
        errorMessage: "OpenWork client disconnected",
      }),
    }));
    expect(prismaMock.executionResult.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "REJECTED",
        writebackEntityType: null,
        writebackEntityId: null,
      }),
    }));
    expect(createAction).not.toHaveBeenCalled();
  });

  it("rejects a stale different-key claim loser without any result or CRM writes", async () => {
    prismaMock.executionRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({ status: "RESULT_SUBMITTED" }));

    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      lineageRoots: [publicPromptRoot],
      idempotencyKey: "new-result-key",
      output: { title: "Follow up" },
    })).rejects.toThrow("different or incomplete result");

    expect(prismaMock.executionResult.create).not.toHaveBeenCalled();
    expect(prismaMock.executionResult.update).not.toHaveBeenCalled();
    expect(prismaMock.executionRequest.update).not.toHaveBeenCalled();
    expect(createAction).not.toHaveBeenCalled();
    expect(markCommunicationSuggestionSent).not.toHaveBeenCalled();
    expect(createConversationMessage).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("persists comment write-backs as durable execution results", async () => {
    const before = requestFixture({ writebackTargetType: "COMMENT", allowedScopes: ["execution:read", "execution:write"] });
    prismaMock.executionRequest.findFirst.mockResolvedValue(before);
    prismaMock.executionRequest.findUnique.mockResolvedValue(before);
    prismaMock.executionRequest.findUniqueOrThrow.mockResolvedValue({ ...before, status: "RESULT_SUBMITTED" });
    vi.mocked(prepareProducerLineage).mockResolvedValue({ mode: "DERIVED", inputs: [], roots: [publicPromptRoot] });

    const { submitExecutionResult } = await import("./execution-plumbing");
    const result = await submitExecutionResult(agentActor, {
      workspaceId: "workspace-1", requestId: "request-1", lineageRoots: [publicPromptRoot],
      idempotencyKey: "result-key", output: { bodyMd: "Execution note" },
    });
    expect(createAction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "ACCEPTED", writeback: { entityType: "ExecutionResult", entityId: result.id } });
    expect(prismaMock.executionResult.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ id: result.id, status: "ACCEPTED", outputJson: { bodyMd: "Execution note" },
        writebackEntityType: "ExecutionResult", writebackEntityId: result.id }),
    }));
    expect(prismaMock.executionResult.update).not.toHaveBeenCalled();
    expect(prepareProducerLineage).toHaveBeenCalledWith(expect.objectContaining({
      copied: true, completeCopy: true, capture: { lineageInputs: [], lineageRoots: expect.arrayContaining([publicPromptRoot]) },
    }));
  });
  it("stores exact locked CRM packet receipts, advances suggestion lineage and keeps proofs out of exported packets", async () => {
    const { createExecutionRequest, getExecutionPacket } = await import("./execution-plumbing");
    await createExecutionRequest(actor, { workspaceId: "workspace-1", goal: "Send reviewed draft", writebackTargetType: "CRM_COMMUNICATION", writebackTargetId: "suggestion-1" });
    const data = prismaMock.executionRequest.create.mock.calls[0][0].data;
    expect(data.contextJson.__crmInputReceipt).toMatchObject({ version: 1, roots: expect.arrayContaining([suggestionSnapshotRoot, publicPromptRoot]) });
    expect(data.contextJson.__crmInputReceipt.roots).not.toEqual(expect.arrayContaining([directSuggestionRoot]));
    expect(captureArtifactInputSnapshotProof).toHaveBeenCalledWith(actor, "workspace-1", directSuggestionRoot, prismaMock);
    expect(prepareProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: prismaMock, actor,
      artifact: { kind: "CrmCommunicationSuggestion", id: "suggestion-1" }, before: expect.objectContaining({ status: "SUGGESTED" }), allowSystemTransition: true }));
    expect(finishProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ artifact: { kind: "CrmCommunicationSuggestion", id: "suggestion-1" },
      content: expect.objectContaining({ status: "REQUESTED", externalRequestId: "request-1" }) }));
    prismaMock.executionRequest.findFirst.mockResolvedValue(requestFixture({ writebackTargetType: "CRM_COMMUNICATION", contextJson: data.contextJson, status: "IN_PROGRESS" }));
    const packet = await getExecutionPacket(actor, { workspaceId: "workspace-1", requestId: "request-1" });
    expect(packet).toMatchObject({ relevantContext: { relationshipCommunication: { bodyMd: "Thanks for the call." } } });
    expect(JSON.stringify(packet)).not.toContain("__crmInputReceipt");
    expect(JSON.stringify(packet)).not.toContain(suggestionSnapshotRoot.fingerprint);
  });

  it("rejects unknown, stale, nonpublic and missing model-context receipts before creating an external packet", async () => {
    const { createExecutionRequest } = await import("./execution-plumbing");
    const params = { workspaceId: "workspace-1", goal: "Send", writebackTargetType: "CRM_COMMUNICATION", writebackTargetId: "suggestion-1" };
    vi.mocked(captureArtifactInputProof).mockRejectedValueOnce(new AppError(409, "UNKNOWN_LINEAGE", "Unproven source."));
    await expect(createExecutionRequest(actor, params)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    vi.mocked(captureArtifactInputSnapshotProof).mockRejectedValueOnce(new AppError(409, "SOURCE_CHANGED", "Suggestion changed while locking."));
    await expect(createExecutionRequest(actor, params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    vi.mocked(isArtifactInputProofPubliclyShareable).mockResolvedValueOnce(false);
    await expect(createExecutionRequest(actor, params)).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    await expect(createExecutionRequest(actor, { ...params, context: { modelOnlySecret: "Uncaptured prompt" } })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(createExecutionRequest(agentActor, params)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(prismaMock.executionRequest.create).not.toHaveBeenCalled();
    expect(prismaMock.crmCommunicationSuggestion.update).not.toHaveBeenCalled();
  });

  it("rechecks CRM packet ancestry for reads, requester changes and idempotent retries before any packet claim", async () => {
    const request = requestFixture({ writebackTargetType: "CRM_COMMUNICATION" });
    prismaMock.executionRequest.findFirst.mockResolvedValue(request);
    prismaMock.executionRequest.findUnique.mockResolvedValue(request);
    vi.mocked(isArtifactInputProofReadable).mockResolvedValue(false);
    const { getExecutionPacket, getExecutionRequest, createExecutionRequest } = await import("./execution-plumbing");
    const otherUser = { ...actor, user: { ...actor.user, id: "other-user" } } as AppActor;
    await expect(getExecutionPacket(otherUser, { workspaceId: "workspace-1", requestId: request.id })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    await expect(getExecutionRequest(actor, { workspaceId: "workspace-1", requestId: request.id })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    await expect(createExecutionRequest(actor, { workspaceId: "workspace-1", goal: "Retry", idempotencyKey: "existing" })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(prismaMock.executionRequest.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.executionRequest.create).not.toHaveBeenCalled();
  });

  it("filters unknown CRM requests and target titles before sampling and rejects malformed pages", async () => {
    const { listExecutionRequests, listWritebackTargets } = await import("./execution-plumbing");
    prismaMock.executionRequest.findMany.mockResolvedValue([
      requestFixture({ id: "unknown", writebackTargetType: "CRM_COMMUNICATION", contextJson: null }),
      requestFixture({ id: "known", writebackTargetType: "CRM_COMMUNICATION" }),
    ]);
    prismaMock.executionRequest.findFirst.mockImplementation(async ({where}) => where.id === "known" ? requestFixture({ id: "known", writebackTargetType: "CRM_COMMUNICATION" }) : null);
    expect((await listExecutionRequests(actor, { workspaceId: "workspace-1", take: 1 })).map((row) => row.id)).toEqual(["known"]);
    prismaMock.crmCommunicationSuggestion.findMany.mockResolvedValue([
      communicationSuggestionFixture({ id: "unproven", title: "Hidden raw title" }), communicationSuggestionFixture({ id: "known", title: "Public draft", subject: null }),
    ]);
    vi.mocked(captureArtifactInputProof).mockImplementation(async (_reader, _ws, inputs) => {
      if (inputs.some((input) => input.id === "unproven")) throw new AppError(409, "UNKNOWN_LINEAGE", "Unknown source.");
      return [publicPromptRoot];
    });
    expect((await listWritebackTargets(actor, { workspaceId: "workspace-1", targetTypes: ["CRM_COMMUNICATION"], take: 1 })).items.map((row) => row.title)).toEqual(["Public draft"]);
    prismaMock.executionRequest.findMany.mockResolvedValue(Array.from({ length: 5001 }, () => requestFixture()));
    await expect(listExecutionRequests(actor, { workspaceId: "workspace-1" })).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_CHANGED" });
  });
  it("replenishes title-matching targets beyond 5000 unrelated rows without a lifetime cap", async () => {
    const rows=Array.from({length:5002},(_,index)=>({id:String(index).padStart(5,"0"),title:index<5001?"Unrelated":"Late MATCH",updatedAt:new Date("2026-01-01"),status:"OPEN"}));
    prismaMock.action.findMany.mockImplementation(async args=>{
      expect(args.take).toBe(100);
      const after=args.where.AND?.[1]?.OR?.[1]?.id?.gt;
      return rows.filter(row=>!after||row.id>after).slice(0,args.take);
    });
    const {listWritebackTargets}=await import("./execution-plumbing");
    expect((await listWritebackTargets(actor,{workspaceId:"workspace-1",targetTypes:["ACTION"],query:"match",take:1})).items.map(row=>row.id)).toEqual(["05001"]);
    expect(prismaMock.action.findMany).toHaveBeenCalledTimes(51);
  });

  it("keeps coalesced Meeting ranking while hydrating only canonical pages", async () => {
    const rows=Array.from({length:101},(_,index)=>({id:String(index).padStart(3,"0"),title:"Meeting",updatedAt:new Date("2026-01-01"),recordedAt:index===100?new Date("2026-02-01"):null,status:"COMPLETED"}));
    prismaMock.meeting.findMany.mockImplementation(async args=>{
      expect(args.take).toBe(100);
      const after=args.where.AND?.[1]?.id?.gt;
      return rows.filter(row=>!after||row.id>after).slice(0,args.take);
    });
    const {listWritebackTargets}=await import("./execution-plumbing");
    expect((await listWritebackTargets(actor,{workspaceId:"workspace-1",targetTypes:["MEETING"],take:1})).items[0].id).toBe("100");
    expect(prismaMock.meeting.findMany).toHaveBeenCalledTimes(2);
  });

});
