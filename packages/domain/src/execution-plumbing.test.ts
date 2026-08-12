import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    workspace: {
      findUnique: vi.fn(),
    },
    executionRequest: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    executionResult: {
      create: vi.fn(),
      findUnique: vi.fn(),
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
    agentCredentialId: null,
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
  };
}

describe("execution plumbing domain", () => {
  let lastCreatedRequestData: Record<string, unknown> | null;
  let lastCreatedResultData: Record<string, unknown> | null;

  beforeEach(() => {
    vi.resetAllMocks();
    lastCreatedRequestData = null;
    lastCreatedResultData = null;
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.workspace.findUnique.mockResolvedValue(workspace);
    prismaMock.executionRequest.findFirst.mockResolvedValue(requestFixture());
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
      writebackTargetType: "CRM_COMMUNICATION", writebackTargetId: "suggestion-1" })).rejects.toMatchObject({ code: "CRM_LINK_CLOSURE_CHANGED" });
    expect(prismaMock.executionRequest.create).not.toHaveBeenCalled();
    expect(prismaMock.crmCommunicationSuggestion.update).not.toHaveBeenCalled();
  });

  it("returns an existing execution request on concurrent idempotency create races", async () => {
    prismaMock.executionRequest.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(requestFixture({ id: "request-race", results: [] }));
    prismaMock.$transaction.mockRejectedValueOnce({ code: "P2002" });

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

  it("returns an existing result for duplicate idempotency keys without writing again", async () => {
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
  });

  it("does not return duplicate results before workspace-scoped request authorization", async () => {
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
        title: { contains: "launch", mode: "insensitive" },
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
        ],
      }),
    }));
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
      .mockResolvedValueOnce(requestFixture({ status: "IN_PROGRESS", claimedAt: new Date("2026-06-02T10:05:00.000Z") }));

    const { getExecutionPacket } = await import("./execution-plumbing");
    const packet = await getExecutionPacket(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
    });

    expect(packet).toMatchObject({ id: "request-1", status: "IN_PROGRESS" });
    expect(prismaMock.executionRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "request-1",
        workspaceId: "workspace-1",
        agentCredentialId: "cred-1",
        status: "PENDING",
      }),
      data: expect.objectContaining({ status: "IN_PROGRESS" }),
    }));
    expect(prismaMock.executionRequest.update).not.toHaveBeenCalled();
  });

  it("rejects packet claim losers after the pending-state compare-and-swap", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({ status: "PENDING" }));
    prismaMock.executionRequest.updateMany.mockResolvedValueOnce({ count: 0 });

    const { getExecutionPacket } = await import("./execution-plumbing");
    await expect(getExecutionPacket(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
    })).rejects.toThrow("Execution packet is no longer available for claiming.");

    expect(prismaMock.executionRequest.findFirst).toHaveBeenCalledTimes(1);
  });

  it("creates draft native records and audits accepted results", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture());

    const { submitExecutionResult } = await import("./execution-plumbing");
    const result = await submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      idempotencyKey: "result-key",
      output: {
        title: " Follow up ",
        bodyMd: "Notes",
        apiKey: "secret",
        downloadUrl: "https://example.test/file?access_token=clear-token&ok=1",
      },
      artifacts: [{ log: "Authorization: Bearer clear-token-value" }],
    });

    expect(createAction).toHaveBeenCalledWith(expect.objectContaining({
      kind: "user",
      user: expect.objectContaining({ id: "user-1" }),
    }), expect.objectContaining({
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

  it("marks CRM communication suggestions sent and appends conversation notes from accepted results", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({
      status: "IN_PROGRESS",
      writebackTargetType: "CRM_COMMUNICATION",
      writebackTargetId: "suggestion-1",
      allowedScopes: ["execution:read", "execution:write", "relationships:write"],
    }));

    const { submitExecutionResult } = await import("./execution-plumbing");
    const result = await submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      idempotencyKey: "crm-result-key",
      output: {
        sentAt: "2026-06-02T10:30:00.000Z",
        conversationId: "conversation-1",
        conversationBodyMd: "Sent externally via OpenWork.",
      },
    });

    expect(markCommunicationSuggestionSent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "user",
      user: expect.objectContaining({ id: "user-1" }),
    }), {
      workspaceId: "workspace-1",
      suggestionId: "suggestion-1",
      sentAt: new Date("2026-06-02T10:30:00.000Z"),
    }, prismaMock);
    expect(createConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: "user",
      user: expect.objectContaining({ id: "user-1" }),
    }), {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      senderType: "ADMIN",
      senderEmail: undefined,
      bodyMd: "Sent externally via OpenWork.",
    }, prismaMock);
    expect(result).toMatchObject({
      status: "ACCEPTED",
      writeback: { entityType: "CrmCommunicationSuggestion", entityId: "suggestion-1" },
    });
  });

  it("marks CRM communication suggestions failed when external execution fails", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({
      status: "IN_PROGRESS",
      writebackTargetType: "CRM_COMMUNICATION",
      writebackTargetId: "suggestion-1",
      allowedScopes: ["execution:read", "execution:write", "relationships:write"],
    }));

    const { submitExecutionResult } = await import("./execution-plumbing");
    const result = await submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      idempotencyKey: "crm-failed-result-key",
      output: { details: "Mailbox unavailable" },
      errorMessage: "External client could not send the email",
    });

    expect(failCommunicationSuggestion).toHaveBeenCalledWith(expect.objectContaining({
      kind: "user",
      user: expect.objectContaining({ id: "user-1" }),
    }), {
      workspaceId: "workspace-1",
      suggestionId: "suggestion-1",
      failureReason: "External client could not send the email",
    }, prismaMock);
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
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({ status: "IN_PROGRESS",
      writebackTargetType: "CRM_COMMUNICATION", writebackTargetId: "suggestion-1",
      allowedScopes: ["execution:read", "execution:write", "relationships:write"] }));
    createConversationMessage.mockRejectedValueOnce(new Error("Conversation not found."));
    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(agentActor, { workspaceId: "workspace-1", requestId: "request-1",
      idempotencyKey: "crm-closure-drift", output: { conversationId: "conversation-1" } }))
      .rejects.toThrow("Conversation not found.");
    expect(markCommunicationSuggestionSent).toHaveBeenCalledWith(expect.anything(), expect.anything(), prismaMock);
    expect(lockActiveCommunicationSuggestion.mock.invocationCallOrder[0])
      .toBeLessThan(markCommunicationSuggestionSent.mock.invocationCallOrder[0]!);
    expect(createConversationMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), prismaMock);
    expect(prismaMock.executionResult.create).not.toHaveBeenCalled();
    expect(prismaMock.executionRequest.update).not.toHaveBeenCalled();
  });

  it("accepts failure results without write-back targets", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({
      writebackTargetType: null,
      writebackTargetId: null,
      writebackTargetLabel: null,
      allowedScopes: ["execution:read", "execution:write"],
    }));

    const { submitExecutionResult } = await import("./execution-plumbing");
    const result = await submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
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

  it("rejects new result submissions after a result is already submitted", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({ status: "RESULT_SUBMITTED" }));

    const { submitExecutionResult } = await import("./execution-plumbing");
    await expect(submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      idempotencyKey: "new-result-key",
      output: { title: "Follow up" },
    })).rejects.toThrow("Execution request is not accepting new results.");

    expect(prismaMock.executionResult.create).not.toHaveBeenCalled();
    expect(createAction).not.toHaveBeenCalled();
  });

  it("persists comment write-backs as durable execution results", async () => {
    prismaMock.executionRequest.findFirst.mockResolvedValueOnce(requestFixture({
      writebackTargetType: "COMMENT",
      allowedScopes: ["execution:read", "execution:write"],
    }));

    const { submitExecutionResult } = await import("./execution-plumbing");
    const result = await submitExecutionResult(agentActor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      idempotencyKey: "result-key",
      output: { bodyMd: "Execution note" },
    });

    expect(createAction).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "ACCEPTED",
      writeback: { entityType: "ExecutionResult", entityId: "result-1" },
    });
    expect(prismaMock.executionResult.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        writebackEntityType: "ExecutionResult",
        writebackEntityId: "result-1",
      }),
    }));
  });
});
