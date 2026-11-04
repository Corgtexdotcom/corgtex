import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  createWorkItemMock,
  deleteActionMock,
  deleteProposalMock,
  deleteSourceMock,
  deleteTensionMock,
  deliverSlackAgentResponseMock,
  fetchSlackThreadMessagesMock,
  listMembersMock,
  extractMock,
  chatMock,
  answerKnowledgeQuestionMock,
  searchIndexedKnowledgeMock,
} = vi.hoisted(() => ({
  prismaMock: {
    agentRun: {
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    agentStep: {
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
    agentToolCall: {
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
    workspaceAgentConfig: {
      findUnique: vi.fn(),
    },
    modelUsageBudget: {
      findUnique: vi.fn(),
    },
    agentIdentity: {
      findUnique: vi.fn(),
    },
    event: {
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
    },
    communicationExternalUser: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    communicationChannel: { findFirst: vi.fn() },
    agentRequestInput: { findFirst: vi.fn() },
    communicationMessage: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    communicationContextSummary: {
      findMany: vi.fn(),
    },
    communicationEntityLink: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    action: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    tension: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    proposal: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    brainSource: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  createWorkItemMock: vi.fn(),
  deleteActionMock: vi.fn(),
  deleteProposalMock: vi.fn(),
  deleteSourceMock: vi.fn(),
  deleteTensionMock: vi.fn(),
  deliverSlackAgentResponseMock: vi.fn(),
  fetchSlackThreadMessagesMock: vi.fn(),
  listMembersMock: vi.fn(),
  extractMock: vi.fn(),
  chatMock: vi.fn(),
  answerKnowledgeQuestionMock: vi.fn(),
  searchIndexedKnowledgeMock: vi.fn(),
}));

const lineage = vi.hoisted(() => {
  const epochs = new Map<string, number>();
  const revoked = new Set<string>();
  const unknown = new Set<string>();
  const privateIds = new Set<string>();
  const rows = new Map<string, any>();
  const operations: any[] = [];
  const recorded: any[] = [];
  const invalidated: any[] = [];
  const behaviorRoots: any[] = [];
  const root = (input: any) => ({ kind: input.kind, id: input.id, fingerprint: JSON.stringify(input.snapshot ?? input), epoch: epochs.get(input.id) ?? 0 });
  const capture = vi.fn(async (_actor: any, _ws: string, inputs: any[]) => {
    if (inputs.some(input => unknown.has(input.id) || revoked.has(input.id))) throw Object.assign(new Error("Unavailable source"), { code: "UNKNOWN_LINEAGE" });
    for (const input of inputs) if (input.snapshot) rows.set(input.id, input.snapshot);
    return inputs.map(root);
  });
  const readable = vi.fn(async (_actor: any, _ws: string, roots: any[]) => roots.every(root => !revoked.has(root.id) && !unknown.has(root.id) && (root.epoch ?? 0) === (epochs.get(root.id) ?? 0)
    && (!rows.has(root.id) || JSON.stringify(rows.get(root.id)) === root.fingerprint)));
  const publicProof = vi.fn(async (_actor: any, _ws: string, roots: any[]) => roots.every(root => !revoked.has(root.id) && !unknown.has(root.id) && !privateIds.has(root.id) && root.kind !== "AgentRequestInput"));
  const merge = (...proofs: any[][]) => [...new Map(proofs.flat().map(root => [`${root.kind}:${root.id}`, root])).values()];
  const captureRows = vi.fn(async ({ actor, workspaceId, kind, records }: any) => {
    const permitted = records.filter((row: any) => !unknown.has(row.id) && !revoked.has(row.id));
    const proofs = new Map<any, any[]>();
    for (const row of permitted) proofs.set(row.id, await capture(actor, workspaceId, [{ kind, id: row.id, snapshot: row }]));
    return { records: permitted, proofs, roots: merge(...proofs.values()) };
  });
  const target = vi.fn(async (_install: string, channelId: string) => ({ ok: true, channelId }));
  const knowledgeRoots = vi.fn(async (_actor: any, _ws: string, rows: any[]) => rows.map(row => ({ kind: "KnowledgeChunk", id: row.chunkId, fingerprint: row.snippet })));
  const run = vi.fn();
  return { epochs, revoked, unknown, privateIds, rows, operations, recorded, invalidated, behaviorRoots, capture, readable, publicProof, merge, captureRows, target, knowledgeRoots, run };
});

vi.mock("../runtime", () => ({
  asString: (value: unknown) => typeof value === "string" ? value.trim() : "",
  executeAgentRun: lineage.run,
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  env: {
    AGENT_KILL_SWITCH: false,
    WORKSPACE_AGENT_MAX_CONCURRENCY: 4,
  },
  toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value ?? null)),
}));

vi.mock("@corgtex/domain", () => ({
  AGENT_REGISTRY: {
    "slack-agent": {
      defaultModelTier: "standard",
    },
  },
  checkBudget: vi.fn().mockResolvedValue({ allowed: true }),
  isAgentEnabled: vi.fn().mockResolvedValue(true),
  getAgentModelOverride: vi.fn().mockResolvedValue(undefined),
  resolveAgentIdentityLimits: vi.fn().mockResolvedValue(null),
  resolveAgentBehaviorContext: vi.fn().mockResolvedValue(null),
  createConstitutionVersion: vi.fn(),
  captureArtifactInputProof: lineage.capture,
  captureArtifactInputSnapshotProof: vi.fn(async (_actor, _ws, root) => [root]),
  captureImmutableArtifactInputProof: vi.fn(async (_actor, _ws, roots) => roots),
  recordArtifactInputLineage: vi.fn(async params => { lineage.recorded.push(params); }),
  invalidateArtifactInputLineage: vi.fn(async params => { lineage.invalidated.push(params); }),
  readableArtifactIds: vi.fn(async (_actor, _ws, _kind, records) => new Set(records.filter((row: any) => !lineage.revoked.has(row.id) && !lineage.unknown.has(row.id)).map((row: any) => row.id))),
  withArtifactInputReadCapture: vi.fn(async (_actor, _ws, work) => ({ value: await work(), roots: [] })),
  captureReadableDigestInputs: lineage.captureRows,
  isArtifactInputProofReadable: lineage.readable,
  isArtifactInputProofPubliclyShareable: lineage.publicProof,
  mergeArtifactInputProofs: lineage.merge,
  validateSlackPostTarget: lineage.target,
  invariant: (condition: unknown, _status: number, code: string, message: string) => { if (!condition) throw Object.assign(new Error(message), { code }); },
  createWorkItemFromCommunicationSource: createWorkItemMock,
  deleteAction: deleteActionMock,
  deleteProposal: deleteProposalMock,
  deleteSource: deleteSourceMock,
  deleteTension: deleteTensionMock,
  deliverSlackAgentResponse: deliverSlackAgentResponseMock,
  evaluateDelegatedActionPolicy: vi.fn((input: { confidence?: number | null; explicitUserIntent?: boolean }) => {
    if (input.explicitUserIntent || input.confidence == null || input.confidence >= 0.8) {
      return { policyClass: "normal_write", autoRunAllowed: true, requiresSensitiveHandling: false, reason: "test" };
    }
    return { policyClass: "draft_or_clarify", autoRunAllowed: false, requiresSensitiveHandling: false, reason: "test" };
  }),
  fetchSlackThreadMessages: fetchSlackThreadMessagesMock,
  fetchAndPersistReadableSlackThreadMessages: fetchSlackThreadMessagesMock,
  isHumanMemberIdentity: (member: { kind?: string; user?: { email?: string; displayName?: string } }) => member.kind !== "SYSTEM" && !member.user?.email?.startsWith("system+") && !member.user?.displayName?.endsWith(" System"),
  listMembers: listMembersMock,
}));

vi.mock("@corgtex/models", () => ({
  resolveModel: vi.fn().mockReturnValue("fake-model"),
  defaultModelGateway: {
    extract: extractMock,
    chat: chatMock,
  },
}));

vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge: searchIndexedKnowledgeMock,
  getKnowledgeSearchInputRoots: lineage.knowledgeRoots,
  answerKnowledgeQuestion: answerKnowledgeQuestionMock,
}));

function basePayload() {
  return {
    source: "slash_command" as const,
    requestInputId: "request-1",
    installationId: "install-1",
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    externalUserId: "U1",
    prompt: "Jan should follow up with Milan tomorrow",
    channelId: "C1",
    responseUrlEnc: "enc:https://hooks.slack.test/response",
    workflowJobId: "job-1",
  };
}

async function runTrustedSlackAgent(run: (payload: any) => Promise<any>, payload: any) {
  // Synthetic signed ingress persists the authored request before the worker runs.
  prismaMock.agentRequestInput.findFirst.mockResolvedValue({ id: payload.requestInputId ?? "request-1", workspaceId: payload.workspaceId,
    userId: payload.actorUserId, agentKey: "slack-agent", prompt: payload.prompt });
  if (payload.source === "app_mention") {
    prismaMock.communicationMessage.findFirst.mockResolvedValue({ id: payload.sourceMessageId ?? "incoming-message",
      workspaceId: payload.workspaceId, installationId: payload.installationId, provider: "SLACK", externalChannelId: payload.channelId,
      externalUserId: payload.externalUserId, externalMessageId: payload.messageTs ?? "1714320100.000100",
      threadExternalId: payload.threadTs ?? payload.messageTs ?? "1714320100.000100", text: payload.prompt });
  }
  return run({ ...payload, messageTs: payload.source === "app_mention" ? payload.messageTs ?? "1714320100.000100" : payload.messageTs });
}

describe("runSlackAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lineage.epochs.clear(); lineage.revoked.clear(); lineage.unknown.clear(); lineage.privateIds.clear(); lineage.rows.clear();
    lineage.operations.length = 0; lineage.recorded.length = 0; lineage.invalidated.length = 0; lineage.behaviorRoots.length = 0;
    lineage.target.mockResolvedValue({ ok: true, channelId: "C1" });
    lineage.run.mockImplementation(async params => {
      const helpers = {
        behaviorContext: lineage.behaviorRoots.length ? "SYNTHETIC current behavior" : null, behaviorLineageRoots: lineage.behaviorRoots,
        captureInputs: async (roots: any[]) => {
          if (!await lineage.readable(params.lineageActor, params.workspaceId, roots)) throw Object.assign(new Error("Revoked captured input"), { code: "SOURCE_CHANGED" });
          return { kind: "agent-input-receipt", roots };
        },
        tool: async (name: string, input: unknown, work: (operation: import("../runtime").AgentOperationContext) => Promise<any>, proof: any) => {
          expect(proof?.receipt?.roots.length).toBeGreaterThan(0);
          if (!await lineage.readable(params.lineageActor, params.workspaceId, proof.receipt.roots)) throw Object.assign(new Error("Revoked operation input"), { code: "SOURCE_CHANGED" });
          lineage.operations.push({ name, input, roots: proof.receipt.roots });
          return work({modelRequest: (request: any) => request});
        },
      };
      const context = await params.buildContext(helpers, "run-1");
      return params.execute(context, helpers, "run-1", "fake-model");
    });
    prismaMock.communicationChannel.findFirst.mockResolvedValue({ id: "channel-1", workspaceId: "workspace-1", installationId: "install-1",
      provider: "SLACK", externalChannelId: "C1", kind: "PUBLIC", isIngestEnabled: true, isArchived: false });
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));
    prismaMock.agentRun.findFirst.mockResolvedValue(null);
    prismaMock.agentRun.count.mockResolvedValue(0);
    prismaMock.agentRun.create.mockResolvedValue({ id: "run-1" });
    prismaMock.agentRun.update.mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    }));
    prismaMock.agentStep.createMany.mockResolvedValue({ count: 0 });
    prismaMock.agentToolCall.createMany.mockResolvedValue({ count: 0 });
    prismaMock.workspaceAgentConfig.findUnique.mockResolvedValue(null);
    prismaMock.modelUsageBudget.findUnique.mockResolvedValue(null);
    prismaMock.agentIdentity.findUnique.mockResolvedValue(null);
    prismaMock.event.create.mockResolvedValue({ id: "event-1" });
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });
    prismaMock.member.findUnique.mockResolvedValue({
      id: "actor-member-1", workspaceId: "workspace-1", userId: "user-1",
      isActive: true, user: { id: "user-1", email: "user@example.test", displayName: "User" },
    });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({
      id: "external-user-1", workspaceId: "workspace-1", installationId: "install-1", provider: "SLACK", externalUserId: "U1", userId: "user-1", memberId: "actor-member-1", isDeleted: false, isBot: false,
      rawProfile: { tz: "America/Los_Angeles" },
    });
    prismaMock.communicationExternalUser.findMany.mockImplementation(async () => [await prismaMock.communicationExternalUser.findUnique()]);
    prismaMock.communicationMessage.findUnique.mockResolvedValue(null);
    prismaMock.communicationMessage.findMany.mockResolvedValue([]);
    prismaMock.communicationContextSummary.findMany.mockResolvedValue([]);
    prismaMock.communicationEntityLink.findMany.mockResolvedValue([]);
    prismaMock.communicationEntityLink.create.mockResolvedValue({ id: "undo-link-1" });
    prismaMock.action.findMany.mockResolvedValue([]);
    prismaMock.action.findFirst.mockImplementation(async ({ where }) => ({ id: where.id, title: "Synthetic stored action", bodyMd: "Synthetic body", archivedAt: null }));
    prismaMock.tension.findMany.mockResolvedValue([]);
    prismaMock.tension.findFirst.mockImplementation(async ({ where }) => ({ id: where.id, title: "Synthetic stored tension", bodyMd: "Synthetic body", archivedAt: null }));
    prismaMock.proposal.findMany.mockResolvedValue([]);
    prismaMock.proposal.findFirst.mockImplementation(async ({ where }) => ({ id: where.id, title: "Synthetic stored proposal", bodyMd: "Synthetic body", archivedAt: null }));
    prismaMock.brainSource.findFirst.mockResolvedValue(null);
    listMembersMock.mockResolvedValue([
      {
        id: "member-1",
        userId: "assignee-user-1",
        user: {
          id: "assignee-user-1", email: "milan@example.test",
          displayName: "Milan",
        },
      },
    ]);
    fetchSlackThreadMessagesMock.mockResolvedValue([]);
    deliverSlackAgentResponseMock.mockResolvedValue(undefined);
    createWorkItemMock.mockResolvedValue({
      entityType: "Action",
      entityId: "action-1",
      webUrl: "https://app.example.test/workspaces/workspace-1/actions",
      opened: true,
    });
    deleteActionMock.mockResolvedValue({ id: "action-1" });
    deleteProposalMock.mockResolvedValue({ id: "proposal-1" });
    deleteSourceMock.mockResolvedValue({ id: "source-1" });
    deleteTensionMock.mockResolvedValue({ id: "tension-1" });
    answerKnowledgeQuestionMock.mockResolvedValue({
      answer: "The workspace handbook says to use advice routing for proposal risks.",
      citations: [],
    });
    searchIndexedKnowledgeMock.mockResolvedValue([]);
    chatMock.mockResolvedValue({
      content: "The workspace handbook says to use advice routing for proposal risks.",
    });
  });

  it("creates and opens high-confidence actions with assignee and due date", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_action",
        confidence: 0.91,
        title: "Follow up with Milan",
        bodyMd: "Jan should follow up with Milan tomorrow.",
        assigneeHint: "Milan",
        dueDateISO: "2026-04-28T16:00:00.000Z",
        publish: true,
      },
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, basePayload());

    expect(createWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), expect.objectContaining({
      kind: "ACTION",
      title: "Follow up with Milan",
      assigneeMemberId: "member-1",
      dueAt: new Date("2026-04-28T16:00:00.000Z"),
      open: true,
    }));
    expect(deliverSlackAgentResponseMock).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      text: expect.stringContaining("Done:"),
    }), expect.objectContaining({ authorizeAttempt: expect.any(Function), signal: expect.any(AbortSignal) }));
  });

  it("keeps an Action private and asks for a human owner when Slack names none", async () => {
    extractMock.mockResolvedValueOnce({ output: {
      intent: "create_action", confidence: 0.94, title: "Send the renewal packet", bodyMd: "Send it by Friday.",
      assigneeHint: null, dueDateISO: null, publish: true,
    } });
    createWorkItemMock.mockResolvedValueOnce({
      entityType: "Action", entityId: "action-2", webUrl: "https://app.example.test/actions/action-2", opened: false,
    });
    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, basePayload());
    expect(createWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), expect.objectContaining({
      kind: "ACTION", assigneeMemberId: null, open: false,
    }));
    expect(deliverSlackAgentResponseMock).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      text: expect.stringContaining("Assign an active Corgtex member"),
    }), expect.objectContaining({ authorizeAttempt: expect.any(Function), signal: expect.any(AbortSignal) }));
  });

  it("does not assign an Action to a system member matched in Slack", async () => {
    listMembersMock.mockResolvedValueOnce([{ id: "system-member", userId: "system-user", kind: "SYSTEM", user: { id: "system-user", email: "system+agent@example.test", displayName: "Workspace System" } }]);
    extractMock.mockResolvedValueOnce({ output: {
      intent: "create_action", confidence: 0.94, title: "Send the renewal packet", bodyMd: "Send it by Friday.",
      assigneeHint: "Workspace System", dueDateISO: null, publish: true,
    } });
    createWorkItemMock.mockResolvedValueOnce({ entityType: "Action", entityId: "action-2", webUrl: "https://app.example.test/actions/action-2", opened: false });
    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, basePayload());
    expect(createWorkItemMock).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      kind: "ACTION", assigneeMemberId: null, open: false,
    }));
  });

  it("creates and submits high-confidence proposals", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_proposal",
        confidence: 0.86,
        title: "Clarify onboarding ownership",
        bodyMd: "Proposal body.",
      },
    });
    createWorkItemMock.mockResolvedValueOnce({
      entityType: "Proposal",
      entityId: "proposal-1",
      webUrl: "https://app.example.test/workspaces/workspace-1/proposals/proposal-1",
      opened: true,
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), prompt: "Create a proposal about onboarding ownership" });

    expect(createWorkItemMock).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      kind: "PROPOSAL",
      open: true,
    }));
  });

  it("keeps medium-confidence work as a private draft", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_tension",
        confidence: 0.71,
        title: "Onboarding ownership is unclear",
        bodyMd: "The handoff owner is unclear.",
      },
    });
    createWorkItemMock.mockResolvedValueOnce({
      entityType: "Tension",
      entityId: "tension-1",
      webUrl: "https://app.example.test/workspaces/workspace-1/tensions/tension-1",
      opened: false,
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), prompt: "Turn this into a tension" });

    expect(createWorkItemMock).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      kind: "TENSION",
      open: false,
    }));
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("private draft");
  });

  it("asks for clarification when confidence is low", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_action",
        confidence: 0.42,
        title: "Unclear request",
        bodyMd: "Maybe do something.",
      },
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), prompt: "maybe this thing" });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("not confident");
  });

  it("answers capabilities questions without calling the model", async () => {
    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), prompt: "what can you do from Slack now?" });

    expect(extractMock).not.toHaveBeenCalled();
    expect(answerKnowledgeQuestionMock).not.toHaveBeenCalled();
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("actions, tensions, proposals");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("Try `/corgtex Jan should follow up with Milan tomorrow`");
  });

  it("does not treat creation prompts containing help as capabilities questions", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_action",
        confidence: 0.89,
        title: "Help Jan follow up",
        bodyMd: "Help Jan follow up tomorrow.",
        assigneeHint: "Milan",
        dueDateISO: "2026-04-28T16:00:00.000Z",
      },
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), prompt: "help Jan follow up tomorrow" });

    expect(extractMock).toHaveBeenCalled();
    expect(createWorkItemMock).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      kind: "ACTION",
      title: "Help Jan follow up",
      open: true,
    }));
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).not.toContain("I can turn plain Slack text into Corgtex work");
  });

  it("declines unsupported destructive requests without creating records", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_action",
        confidence: 0.95,
        title: "Delete stale actions",
        bodyMd: "Delete old actions.",
      },
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), prompt: "delete all old actions" });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deleteActionMock).not.toHaveBeenCalled();
    expect(deleteProposalMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("I cannot do that from Slack");
  });

  it("archives the most recent Slack-created proposal from the same thread", async () => {
    prismaMock.communicationEntityLink.findMany.mockResolvedValueOnce([
      {
        id: "link-1",
        action: "create_proposal",
        entityType: "Proposal",
        entityId: "proposal-1",
        createdAt: new Date("2026-04-28T16:00:00.000Z"),
      },
    ]);
    prismaMock.proposal.findFirst.mockResolvedValueOnce({
      id: "proposal-1",
      title: "Clarify onboarding ownership",
      archivedAt: null,
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, {
      ...basePayload(),
      source: "app_mention",
      prompt: "can you delete that proposal you just created",
      sourceMessageId: "delete-message-1",
      channelId: "C1",
      threadTs: "1714320000.000100",
      messageTs: "1714320100.000100",
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        installationId: "install-1",
        externalUserId: "U1",
        entityType: { in: ["Proposal"] },
        message: expect.objectContaining({
          externalChannelId: "C1",
          OR: [
            { externalMessageId: "1714320000.000100" },
            { threadExternalId: "1714320000.000100" },
          ],
        }),
      }),
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    }));
    expect(deleteProposalMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), {
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
    });
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        installationId: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        messageId: "delete-message-1",
        externalUserId: "U1",
        entityType: "Proposal",
        entityId: "proposal-1",
        action: "undo_create_proposal",
      }),
    });
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toBe("I undid the Slack-created item.");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).not.toContain("Clarify onboarding ownership");
  });

  it("does not archive arbitrary records when no Slack-created undo target exists", async () => {
    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), prompt: "undo that last action" });

    expect(extractMock).not.toHaveBeenCalled();
    expect(deleteActionMock).not.toHaveBeenCalled();
    expect(deleteProposalMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("could not undo an item");
  });

  it("answers workspace questions from indexed knowledge", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "answer_question",
        confidence: 0.82,
        title: "Advice routing",
        bodyMd: "What does advice routing do?",
      },
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), prompt: "What does advice routing do?" });

    expect(searchIndexedKnowledgeMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1", query: "What does advice routing do?",
    }));
    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      taskType: "AGENT",
    }));
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("workspace handbook");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).not.toContain("Done:");
  });

  it("answers using stored Slack thread, channel, summaries, and Brain chunks", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "answer_question",
        confidence: 0.84,
        title: "Budget cap",
        bodyMd: "What budget cap was agreed in this thread?",
      },
    });
    fetchSlackThreadMessagesMock.mockResolvedValueOnce([
        {
          id: "thread-message-1",
          text: "We agreed the pilot budget cap is $20k.",
          externalUserId: "U2",
          externalMessageId: "1714320000.000100",
          threadExternalId: "1714320000.000100",
          messageTs: new Date("2024-04-28T16:00:00.000Z"),
        },
      ]);
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
        {
          id: "channel-message-1",
          text: "Finance also asked for weekly spend updates.",
          externalUserId: "U3",
          externalMessageId: "1714319900.000100",
          threadExternalId: null,
          messageTs: new Date("2024-04-28T15:58:20.000Z"),
        },
      ]);
    prismaMock.communicationContextSummary.findMany.mockResolvedValueOnce([
      {
        id: "summary-1", title: "Slack #general thread 2024-04-28",
        summaryMd: "The thread settled on a $20k pilot budget cap and weekly spend updates.",
        threadExternalId: "1714320000.000100",
        summaryDate: new Date("2024-04-28T00:00:00.000Z"),
        messageCount: 3,
      },
    ]);
    searchIndexedKnowledgeMock.mockResolvedValueOnce([
      {
        chunkId: "knowledge-1", title: "Slack #general",
        snippet: "Slack message confirms the pilot budget cap is $20k.",
        metadata: { permalink: "https://slack.test/archives/C1/p1714320000000100" },
      },
    ]);
    chatMock.mockResolvedValueOnce({ content: "The agreed pilot budget cap is $20k." });

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, {
      ...basePayload(),
      source: "app_mention",
      prompt: "What budget cap was agreed in this thread?",
      threadTs: "1714320000.000100",
      messageTs: "1714320100.000100",
    });

    expect(searchIndexedKnowledgeMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      query: "What budget cap was agreed in this thread?",
    }));
    const conversationCall = chatMock.mock.calls.find((call) => call[0]?.taskType === "AGENT");
    expect(conversationCall).toBeDefined();
    const promptPayload = JSON.parse(conversationCall?.[0].messages[1].content);
    expect(promptPayload.threadMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "We agreed the pilot budget cap is $20k." }),
    ]));
    expect(promptPayload.channelMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Finance also asked for weekly spend updates." }),
    ]));
    expect(promptPayload.slackContextSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summaryMd: expect.stringContaining("$20k") }),
    ]));
    expect(promptPayload.knowledge).toEqual(expect.arrayContaining([
      expect.objectContaining({ snippet: expect.stringContaining("$20k") }),
    ]));
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("$20k");
  });

  it("answers read-only member list requests conversationally", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "unsupported",
        confidence: 0.2,
        title: "List members",
        bodyMd: "list all the members",
      },
    });
    listMembersMock.mockResolvedValueOnce([
      {
        id: "member-1",
        userId: "user-1",
        role: "ADMIN",
        user: {
          id: "user-1", email: "user@example.test",
          displayName: "User",
        },
      },
      {
        id: "member-2",
        userId: "user-2",
        role: "CONTRIBUTOR",
        user: {
          id: "user-2", email: "milan@example.test",
          displayName: "Milan",
        },
      },
    ]);

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), prompt: "list all the members" });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(answerKnowledgeQuestionMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("I found 2 active members");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("Milan");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).not.toContain("Done:");
  });

  it("answers account lookup requests for the linked Slack user", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "unsupported",
        confidence: 0.1,
        title: "Find account",
        bodyMd: "can you find my account now",
      },
    });
    prismaMock.communicationExternalUser.findMany.mockResolvedValueOnce([
      {
        id: "external-user-1", externalUserId: "U1",
        userId: "user-1",
        memberId: "member-1",
        email: "user@example.test",
        displayName: "User",
      },
    ]);
    listMembersMock.mockResolvedValueOnce([
      {
        id: "member-1",
        userId: "user-1",
        role: "ADMIN",
        user: {
          id: "user-1", email: "user@example.test",
          displayName: "User",
        },
      },
    ]);

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), prompt: "can you find my account now" });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("I found your Corgtex account");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("user@example.test");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).not.toContain("Done:");
  });

  it("does not expose workspace data when the Slack user is not an active member", async () => {
    prismaMock.member.findUnique.mockResolvedValueOnce(null);

    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), prompt: "list all the members" });

    expect(extractMock).not.toHaveBeenCalled();
    expect(listMembersMock).not.toHaveBeenCalled();
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock).not.toHaveBeenCalled();
    expect(lineage.run).not.toHaveBeenCalled();
  });

  it.each(["slash_command", "message_shortcut"])("withholds a legacy %s job with no authored input", async source => {
    const { runSlackAgent } = await import("./slack-agent");
    await expect(runSlackAgent({ ...basePayload(), source: source as any, requestInputId: null })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(lineage.run).not.toHaveBeenCalled();
    expect(extractMock).not.toHaveBeenCalled();
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock).not.toHaveBeenCalled();
  });

  it("uses the immutable authored request instead of forged queued text", async () => {
    prismaMock.agentRequestInput.findFirst.mockResolvedValue({ id: "request-1", workspaceId: "workspace-1", userId: "user-1", agentKey: "slack-agent", prompt: "What can you do?" });
    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "FORGED delete the workspace" });
    expect(lineage.run.mock.calls[0][0].payload.prompt).toBe("What can you do?");
    expect(extractMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).not.toContain("FORGED");
    expect(prismaMock.agentRequestInput.findFirst).toHaveBeenCalledWith({ where: { id: "request-1", workspaceId: "workspace-1", userId: "user-1", agentKey: "slack-agent" } });
  });

  it("reconstructs app mentions from the original exact channel and timestamp", async () => {
    prismaMock.communicationMessage.findFirst.mockResolvedValue({ id: "incoming", installationId: "install-1", workspaceId: "workspace-1", provider: "SLACK",
      externalChannelId: "C1", externalMessageId: "1714320100.000100", externalUserId: "U1", threadExternalId: "1714320000.000100", text: "help" });
    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), source: "app_mention", sourceMessageId: "incoming", messageTs: "1714320100.000100", threadTs: "1714320000.000100", prompt: "FORGED private text" });
    expect(lineage.run.mock.calls[0][0].payload.prompt).toBe("help");
    expect(prismaMock.communicationMessage.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ id: "incoming", installationId: "install-1", workspaceId: "workspace-1", externalChannelId: "C1", externalUserId: "U1", externalMessageId: "1714320100.000100" }) });
    expect(lineage.run.mock.calls[0][0].lineageRoots).toContainEqual(expect.objectContaining({ kind: "CommunicationMessage", id: "incoming" }));
    expect(deliverSlackAgentResponseMock.mock.calls[0][0].responseUrlEnc).toBeNull();
  });

  it("replenishes public samples after many private and unknown candidates without exposing counts", async () => {
    const hidden = Array.from({ length: 120 }, (_, index) => ({ id: `hidden-${index}`, title: `PRIVATE ${index}`, bodyMd: "Confidential body", status: "OPEN", createdAt: new Date() }));
    for (const row of hidden.slice(0, 70)) lineage.unknown.add(row.id);
    for (const row of hidden.slice(70)) lineage.privateIds.add(row.id);
    const publicRows = Array.from({ length: 7 }, (_, index) => ({ id: `public-${index}`, title: `Public action ${index}`, bodyMd: "Public body", status: "OPEN", createdAt: new Date() }));
    prismaMock.action.findMany.mockImplementation(async ({ take, cursor }) => {
      const rows = [...hidden, ...publicRows];
      const start = cursor ? rows.findIndex(row => row.id === cursor.id) + 1 : 0;
      return rows.slice(start, start + take);
    });
    extractMock.mockResolvedValueOnce({ output: { intent: "brief", confidence: 0.9 } });
    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention", prompt: "brief" });
    expect(prismaMock.action.findMany.mock.calls.map(([query]) => query.cursor?.id)).toEqual([undefined, "hidden-49", "hidden-99"]);
    const prompt = JSON.parse(extractMock.mock.calls[0][0].input);
    expect(prompt.openActions.map((row: any) => row.id)).toEqual(publicRows.slice(0, 5).map(row => row.id));
    expect(JSON.stringify(prompt)).not.toContain("PRIVATE");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("5 open actions");
    const receipt = lineage.operations.find(op => op.name === "model.extract");
    expect(receipt.roots.some((root: any) => root.id.startsWith("hidden"))).toBe(false);
    expect(receipt.roots.filter((root: any) => root.kind === "Action")).toHaveLength(5);
  });

  it("withholds unknown summaries before the model and inherits complete context and behavior proofs", async () => {
    const known = { id: "known-summary", title: "Public summary", summaryMd: "Permitted synthetic summary", messageCount: 2, summaryDate: new Date(), threadExternalId: null };
    prismaMock.communicationContextSummary.findMany.mockResolvedValue([{ ...known, id: "legacy-summary", summaryMd: "UNKNOWN secret" }, known]);
    lineage.unknown.add("legacy-summary");
    lineage.behaviorRoots.push({ kind: "AgentIdentity", id: "behavior-1", fingerprint: "behavior-revision" });
    extractMock.mockResolvedValueOnce({ output: { intent: "brief", confidence: 0.9 } });
    const { runSlackAgent } = await import("./slack-agent");
    const outcome = await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention", prompt: "brief" });
    expect(extractMock.mock.calls[0][0].input).not.toContain("UNKNOWN secret");
    expect(extractMock.mock.calls[0][0].instruction).toContain("SYNTHETIC current behavior");
    expect(outcome.lineageReceipt.roots).toContainEqual(expect.objectContaining({ kind: "CommunicationContextSummary", id: "known-summary" }));
    expect(outcome.lineageReceipt.roots).toContainEqual(expect.objectContaining({ kind: "AgentIdentity", id: "behavior-1" }));
    expect(outcome.lineageReceipt.roots).toContainEqual(expect.objectContaining({ kind: "User", id: "assignee-user-1" }));
  });

  it.each(["incoming-message", "external-user-1", "channel-1", "behavior-1"])("blocks mutations and replies when %s is revoked during extraction", async id => {
    lineage.behaviorRoots.push({ kind: "AgentIdentity", id: "behavior-1", fingerprint: "behavior-revision" });
    extractMock.mockImplementationOnce(async () => {
      lineage.revoked.add(id);
      return { output: { intent: "create_action", confidence: 0.9, title: "Derived task", bodyMd: "Derived body", assigneeHint: "Milan" } };
    });
    const { runSlackAgent } = await import("./slack-agent");
    await expect(runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention" })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock).not.toHaveBeenCalled();
  });

  it("blocks delivery after a grant changes while the destination is checked", async () => {
    lineage.target.mockImplementationOnce(async () => {
      lineage.revoked.add("incoming-message");
      return { ok: true, channelId: "C1" };
    });
    const { runSlackAgent } = await import("./slack-agent");
    await expect(runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention", prompt: "help" })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(deliverSlackAgentResponseMock).not.toHaveBeenCalled();
  });

  it("rejects private uncited ranking inputs before a public conversational model or reply", async () => {
    extractMock.mockResolvedValueOnce({ output: { intent: "answer_question", confidence: 0.9 } });
    searchIndexedKnowledgeMock.mockResolvedValueOnce([{ chunkId: "public-winner", snippet: "Public answer", title: "Public title" }]);
    lineage.knowledgeRoots.mockResolvedValueOnce([{ kind: "KnowledgeChunk", id: "public-winner", fingerprint: "public" }, { kind: "BrainArticle", id: "uncited-private", fingerprint: "private" }]);
    lineage.privateIds.add("uncited-private");
    const { runSlackAgent } = await import("./slack-agent");
    await expect(runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention", prompt: "What is the policy?" })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(chatMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock).not.toHaveBeenCalled();
  });

  it("passes the complete captured model context into the generated work writer", async () => {
    prismaMock.tension.findMany.mockResolvedValue([{ id: "context-tension", title: "Context tension", bodyMd: "Complete stored body", status: "OPEN" }]);
    extractMock.mockResolvedValueOnce({ output: { intent: "create_proposal", confidence: 0.9, title: "Derived proposal", bodyMd: "Derived body" } });
    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, basePayload());
    expect(createWorkItemMock.mock.calls[0][1].lineageRoots).toContainEqual(expect.objectContaining({ kind: "Tension", id: "context-tension" }));
    expect(createWorkItemMock.mock.calls[0][1].lineageRoots).toContainEqual(expect.objectContaining({ kind: "AgentRequestInput", id: "request-1" }));
  });

  it("keeps an archived-context run UNKNOWN while proving only its independent static undo acknowledgment", async () => {
    const { executeAgentRun } = await vi.importActual<typeof import("../runtime")>("../runtime");
    lineage.run.mockImplementation(executeAgentRun);
    const steps: any[] = [], operations: any[] = [];
    prismaMock.agentStep.createMany.mockImplementation(async ({ data }) => { steps.push(...data); return { count: data.length }; });
    prismaMock.agentToolCall.createMany.mockImplementation(async ({ data }) => { operations.push(...data); return { count: data.length }; });
    prismaMock.agentStep.findMany.mockImplementation(async () => steps);
    prismaMock.agentToolCall.findMany.mockImplementation(async () => operations);
    prismaMock.communicationEntityLink.findMany.mockResolvedValueOnce([{ id: "creation-link", action: "create_proposal", entityType: "Proposal", entityId: "archived-proposal", createdAt: new Date() }]);
    prismaMock.proposal.findFirst.mockResolvedValueOnce({ id: "archived-proposal", title: "PRIVATE OLD TITLE", bodyMd: "Old content", archivedAt: null });
    deleteProposalMock.mockImplementationOnce(async () => {
      lineage.revoked.add("archived-proposal");
      return { id: "archived-proposal" };
    });
    const { runSlackAgent } = await import("./slack-agent");
    const run = await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention", prompt: "undo that proposal" });
    expect(run.status).toBe("COMPLETED");
    expect(extractMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toBe("I undid the Slack-created item.");
    expect(JSON.stringify(deliverSlackAgentResponseMock.mock.calls)).not.toMatch(/PRIVATE OLD TITLE|archived-proposal|creation-link/);
    expect(lineage.invalidated).toContainEqual(expect.objectContaining({ artifact: { kind: "AgentRun", id: "run-1" } }));
    const reply = operations.find(row => row.name === "slack.reply.undo_ack");
    const receipt = lineage.recorded.find(row => row.artifact.kind === "AgentToolCall" && row.artifact.id === reply.id);
    expect(receipt.inheritedRoots).toContainEqual(expect.objectContaining({ kind: "CommunicationMessage", id: "incoming-message" }));
    expect(receipt.inheritedRoots.some((root: any) => ["archived-proposal", "creation-link"].includes(root.id))).toBe(false);
    expect(lineage.recorded.filter(row => row.artifact.kind === "AgentRun").every(row => row.content.status !== "COMPLETED")).toBe(true);
  });


  it("does not publish a newly created private draft title or link into a public Slack channel", async () => {
    extractMock.mockResolvedValueOnce({ output: { intent: "create_action", confidence: 0.9, title: "SYNTHETIC private draft title", bodyMd: "Derived task", assigneeHint: null } });
    createWorkItemMock.mockResolvedValueOnce({ entityType: "Action", entityId: "private-draft", webUrl: "/actions/private-draft", opened: false });
    prismaMock.action.findFirst.mockResolvedValueOnce({ id: "private-draft", title: "SYNTHETIC private draft title", bodyMd: "Derived task", isPrivate: true });
    lineage.privateIds.add("private-draft");
    const { runSlackAgent } = await import("./slack-agent");
    const outcome = await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention" });
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toBe("I completed the request. Review the result in Corgtex.");
    expect(JSON.stringify(deliverSlackAgentResponseMock.mock.calls)).not.toMatch(/private-draft|private draft title/);
    expect(outcome.lineageReceipt.roots).toContainEqual(expect.objectContaining({ kind: "Action", id: "private-draft" }));
    const receipt = lineage.operations.find(op => op.name === "slack.reply.private_result_ack");
    expect(receipt.roots.some((root: any) => root.id === "private-draft")).toBe(false);
  });

  it("requires the newly opened item's current full proof before publishing its details", async () => {
    extractMock.mockResolvedValueOnce({ output: { intent: "create_action", confidence: 0.9, title: "Public action", bodyMd: "Derived public body", assigneeHint: "Milan" } });
    prismaMock.action.findFirst.mockResolvedValueOnce({ id: "action-1", title: "Public action", bodyMd: "Derived public body", isPrivate: false, archivedAt: null });
    const { runSlackAgent } = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention" });
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("Public action");
    const receipt = lineage.operations.find(op => op.name === "slack.reply");
    expect(receipt.roots).toContainEqual(expect.objectContaining({ kind: "Action", id: "action-1" }));
  });


  it("fails explicitly when Slack context exhausts its raw candidate budget", async () => {
    const hidden = Array.from({ length: 5_001 }, (_, index) => ({ id: `unknown-${index}`, title: "UNKNOWN body", status: "OPEN" }));
    for (const row of hidden) lineage.unknown.add(row.id);
    const rows = [...hidden, { id: "readable-tail", title: "Readable tail", status: "OPEN" }];
    prismaMock.action.findMany.mockImplementation(async ({ take, skip = 0, cursor }) => {
      const start = cursor ? rows.findIndex(row => row.id === cursor.id) + skip : skip;
      return rows.slice(start, start + take);
    });
    const { runSlackAgent } = await import("./slack-agent");
    await expect(runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention" })).rejects.toMatchObject({code: "SLACK_CONTEXT_SCAN_LIMIT"});
    expect(prismaMock.action.findMany).toHaveBeenCalledTimes(5);
    expect(prismaMock.action.findMany.mock.calls.at(-1)![0].take).toBe(1);
    expect(extractMock).not.toHaveBeenCalled(); expect(chatMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock).not.toHaveBeenCalled();
  });

  it("keeps an unknown newly created result out of both the reply and the whole-run receipt", async () => {
    extractMock.mockResolvedValueOnce({ output: { intent: "create_action", confidence: 0.9, title: "Derived title", bodyMd: "Derived body", assigneeHint: "Milan" } });
    lineage.unknown.add("action-1");
    const { runSlackAgent } = await import("./slack-agent");
    const outcome = await runTrustedSlackAgent(runSlackAgent, basePayload());
    expect(outcome.lineageReceipt).toBeUndefined();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toBe("I completed the request. Review the result in Corgtex.");
    expect(JSON.stringify(deliverSlackAgentResponseMock.mock.calls)).not.toMatch(/Derived title|action-1/);
  });

  describe("reply transport attempt authority", () => {
    beforeEach(() => {
      lineage.target.mockReset().mockResolvedValue({ ok: true, channelId: "C1" });
      deliverSlackAgentResponseMock.mockReset().mockResolvedValue(undefined);
    });
    it.each([
      ["credentials", "incoming-message"], ["retry", "incoming-message"],
      ["credentials", "actor-member-1"], ["retry", "actor-member-1"],
      ["credentials", "behavior-1"], ["retry", "behavior-1"],
    ] as const)("blocks original %s/%s revoke-restore even if transport swallows denial", async (boundary, revokedId) => {
      lineage.behaviorRoots.push({ kind: "AgentIdentity", id: "behavior-1", fingerprint: "original-behavior", epoch: 0 });
      let sent = 0;
      let denied: unknown;
      let aborted = false;
      let capturesAtTransport = 0;
      deliverSlackAgentResponseMock.mockImplementationOnce(async (_payload, _response, controls) => {
        capturesAtTransport = lineage.capture.mock.calls.length;
        if (boundary === "retry") {
          await controls?.authorizeAttempt({ signal: controls.signal });
          sent++;
        }
        lineage.epochs.set(revokedId, 1); // revoked and restored: current bytes look unchanged
        try { await controls?.authorizeAttempt({ signal: controls.signal }); sent++; } catch (error) { denied = error; }
        aborted = Boolean(controls?.signal.aborted);
        // A transport may translate failure or resolve after its retry engine.
        return { delivered: false };
      });
      const { runSlackAgent } = await import("./slack-agent");
      await expect(runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention", prompt: "help" })).rejects.toThrow();
      expect(denied).toMatchObject({ code: "SOURCE_CHANGED" });
      expect(aborted).toBe(true);
      expect(sent).toBe(boundary === "retry" ? 1 : 0);
      expect(lineage.capture).toHaveBeenCalledTimes(capturesAtTransport);
    });

    it.each(["mapping", "membership", "public audience", "destination"] as const)("blocks late %s loss at a transport attempt", async mutation => {
      let sent = 0;
      let denied: unknown;
      deliverSlackAgentResponseMock.mockImplementationOnce(async (_payload, _response, controls) => {
        if (mutation === "mapping") prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ id: "external-user-1", userId: "another-user", isDeleted: false });
        else if (mutation === "membership") prismaMock.member.findUnique.mockResolvedValue({ id: "actor-member-1", userId: "user-1", isActive: false });
        else if (mutation === "public audience") lineage.privateIds.add("incoming-message");
        else lineage.target.mockResolvedValue({ ok: true, channelId: "C2" });
        try { await controls?.authorizeAttempt({ signal: controls.signal }); sent++; } catch (error) { denied = error; }
      });
      const { runSlackAgent } = await import("./slack-agent");
      await expect(runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention", prompt: "help" })).rejects.toThrow();
      expect(denied).toBeDefined();
      expect(sent).toBe(0);
    });

    it.each(["mapping", "source"] as const)("rechecks %s after the destination await within the transport attempt", async mutation => {
      let sent = 0;
      let denied: unknown;
      deliverSlackAgentResponseMock.mockImplementationOnce(async (_payload, _response, controls) => {
        lineage.target.mockImplementationOnce(async () => {
          if (mutation === "mapping") prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ id: "external-user-1", userId: "another-user", isDeleted: false });
          else lineage.epochs.set("incoming-message", 1);
          return { ok: true, channelId: "C1" };
        });
        try { await controls?.authorizeAttempt({ signal: controls.signal }); sent++; } catch (error) { denied = error; }
      });
      const { runSlackAgent } = await import("./slack-agent");
      await expect(runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention", prompt: "help" })).rejects.toThrow();
      expect(denied).toBeDefined();
      expect(sent).toBe(0);
    });

    it("latches cancellation through a caught attempt and a later retry", async () => {
      let sent = 0;
      const failures: unknown[] = [];
      let aborted = false;
      deliverSlackAgentResponseMock.mockImplementationOnce(async (_payload, _response, controls) => {
        const cancelled = new AbortController(); cancelled.abort(new Error("Synthetic cancellation"));
        for (const signal of [cancelled.signal, controls?.signal]) {
          try { await controls?.authorizeAttempt({ signal }); sent++; } catch (error) { failures.push(error); }
        }
        aborted = Boolean(controls?.signal.aborted);
      });
      const { runSlackAgent } = await import("./slack-agent");
      await expect(runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention", prompt: "help" })).rejects.toThrow();
      expect(failures).toHaveLength(2);
      expect(aborted).toBe(true);
      expect(sent).toBe(0);
    });

    it.each(["public", "private"] as const)("permits current %s reply attempts over the same original proof", async audience => {
      let sent = 0;
      let capturesAtTransport = 0;
      deliverSlackAgentResponseMock.mockImplementationOnce(async (_payload, _response, controls) => {
        capturesAtTransport = lineage.capture.mock.calls.length;
        for (let attempt = 0; attempt < 2; attempt++) { await controls?.authorizeAttempt({ signal: controls.signal }); sent++; }
      });
      const { runSlackAgent } = await import("./slack-agent");
      const outcome = await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: audience === "public" ? "app_mention" : "slash_command", prompt: "help" });
      expect(outcome.resultJson.delivery).toEqual({ delivered: true });
      expect(sent).toBe(2);
      expect(deliverSlackAgentResponseMock.mock.calls[0][2]).toMatchObject({ authorizeAttempt: expect.any(Function), signal: expect.any(AbortSignal) });
      expect(lineage.capture).toHaveBeenCalledTimes(capturesAtTransport);
    });

    it("preserves ordinary delivery failure without an authorization latch", async () => {
      deliverSlackAgentResponseMock.mockRejectedValueOnce(new Error("Synthetic transport unavailable"));
      const { runSlackAgent } = await import("./slack-agent");
      const outcome = await runTrustedSlackAgent(runSlackAgent, { ...basePayload(), source: "app_mention", prompt: "help" });
      expect(outcome.resultJson.delivery).toEqual({ delivered: false, error: "Slack delivery failed." });
    });
  });

  it.each(["app_mention", "slash_command"] as const)("bounds private audience context without denying its owner (%s)", async source => {
    const rows = Array.from({length: 201}, (_, index) => ({id: `private-window-${index}`, title: `Private title ${index}`, status: "OPEN"}));
    rows.forEach(row => lineage.privateIds.add(row.id));
    prismaMock.action.findMany.mockImplementation(async ({take, skip = 0, cursor}) => {
      const start = cursor ? rows.findIndex(row => row.id === cursor.id) + skip : skip;
      return rows.slice(start, start + take);
    });
    extractMock.mockResolvedValueOnce({output: {intent: "brief", confidence: 0.9}});
    const {runSlackAgent} = await import("./slack-agent");
    const run = runTrustedSlackAgent(runSlackAgent, {...basePayload(), source});
    if (source === "app_mention") {
      await expect(run).rejects.toMatchObject({code: "SLACK_CONTEXT_SCAN_LIMIT"});
      expect(prismaMock.action.findMany).toHaveBeenCalledTimes(5);
      expect(extractMock).not.toHaveBeenCalled(); expect(deliverSlackAgentResponseMock).not.toHaveBeenCalled();
    } else {
      await run;
      expect(prismaMock.action.findMany).toHaveBeenCalledOnce();
      expect(extractMock.mock.calls[0][0].input).toContain("Private title 0");
      expect(deliverSlackAgentResponseMock).toHaveBeenCalledOnce();
    }
  });

  it.each([false, true])("distinguishes exhausted Slack context at the raw boundary (readable=%s)", async readable => {
    const rows = Array.from({length: 200}, (_, index) => ({id: `boundary-${index}`, title: `Boundary title ${index}`, status: "OPEN"}));
    rows.slice(0, readable ? 199 : 200).forEach(row => lineage.unknown.add(row.id));
    prismaMock.action.findMany.mockImplementation(async ({take, skip = 0, cursor}) => {
      const start = cursor ? rows.findIndex(row => row.id === cursor.id) + skip : skip;
      return rows.slice(start, start + take);
    });
    extractMock.mockResolvedValueOnce({output: {intent: "brief", confidence: 0.9}});
    const {runSlackAgent} = await import("./slack-agent");
    await runTrustedSlackAgent(runSlackAgent, {...basePayload(), source: "app_mention"});
    expect(prismaMock.action.findMany).toHaveBeenCalledTimes(5);
    expect(prismaMock.action.findMany.mock.calls.at(-1)![0].take).toBe(1);
    expect(JSON.parse(extractMock.mock.calls[0][0].input).openActions).toHaveLength(readable ? 1 : 0);
  });

});
