import { describe, expect, it, vi, beforeEach } from "vitest";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    proposal: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    action: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    tension: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    policyCorpus: {
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
    deliberationEntry: {
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    proposalReaction: {
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    approvalFlow: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    approvalDecision: {
      deleteMany: vi.fn(),
    },
    objection: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => cb(prisma)),
  },
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({
    id: "mem-1",
    workspaceId: "ws-1",
    userId: "u-1",
    role: "MEMBER",
    isActive: true,
  }),
  actorUserIdForWorkspace: vi.fn().mockResolvedValue("u-1"),
}));

vi.mock("./events", () => ({
  appendEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./approvals", () => ({
  ensureApprovalFlow: vi.fn().mockResolvedValue({ id: "flow-1" }),
  getApprovalPolicy: vi.fn().mockResolvedValue({
    mode: "CONSENT",
    decisionWindowHours: 168,
    requireProposalLink: false,
  }),
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: {
    extract: vi.fn(),
  },
}));

function words(count: number) {
  return Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");
}

describe("proposal AI summaries", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("generates a saved summary for long proposals when requested", async () => {
    const { defaultModelGateway } = await import("@corgtex/models");
    const { createProposal } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    vi.mocked(defaultModelGateway.extract).mockResolvedValueOnce({
      output: { summary: "Generated **summary** for the proposal." },
    } as any);
    vi.mocked(prisma.proposal.create).mockResolvedValueOnce({
      id: "p-ai",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Long proposal",
      summary: "Generated summary for the proposal.",
      bodyMd: words(130),
    } as any);

    await createProposal(actor, {
      workspaceId: "ws-1",
      title: "Long proposal",
      bodyMd: words(130),
      includeAiSummary: true,
    });

    expect(defaultModelGateway.extract).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      schemaHint: "{ summary: string }",
    }));
    expect(prisma.proposal.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        summary: "Generated summary for the proposal.",
      }),
    }));
  });

  it("does not generate AI summaries for short proposals", async () => {
    const { defaultModelGateway } = await import("@corgtex/models");
    const { createProposal } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    vi.mocked(prisma.proposal.create).mockResolvedValueOnce({
      id: "p-short",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Short",
      summary: null,
      bodyMd: words(119),
    } as any);

    await createProposal(actor, {
      workspaceId: "ws-1",
      title: "Short",
      bodyMd: words(119),
      includeAiSummary: true,
    });

    expect(defaultModelGateway.extract).not.toHaveBeenCalled();
    expect(prisma.proposal.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        summary: null,
      }),
    }));
  });

  it("keeps manual summaries for callers that do not opt into AI summaries", async () => {
    const { defaultModelGateway } = await import("@corgtex/models");
    const { createProposal } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    vi.mocked(prisma.proposal.create).mockResolvedValueOnce({
      id: "p-manual",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Manual summary",
      summary: "Manual summary",
      bodyMd: words(130),
    } as any);

    await createProposal(actor, {
      workspaceId: "ws-1",
      title: "Manual summary",
      summary: " Manual summary ",
      bodyMd: words(130),
    });

    expect(defaultModelGateway.extract).not.toHaveBeenCalled();
    expect(prisma.proposal.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        summary: "Manual summary",
      }),
    }));
  });

  it("regenerates or clears summaries when draft edits choose the AI summary option", async () => {
    const { defaultModelGateway } = await import("@corgtex/models");
    const { updateProposal } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    vi.mocked(prisma.proposal.findUnique).mockResolvedValueOnce({
      id: "p-edit",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Old title",
      bodyMd: "Old body",
      status: "DRAFT",
      archivedAt: null,
    } as any);
    vi.mocked(defaultModelGateway.extract).mockResolvedValueOnce({
      output: { summary: "Updated AI summary." },
    } as any);
    vi.mocked(prisma.proposal.update).mockResolvedValueOnce({
      id: "p-edit",
      title: "Old title",
      bodyMd: words(130),
      summary: "Updated AI summary.",
      status: "DRAFT",
    } as any);

    await updateProposal(actor, {
      workspaceId: "ws-1",
      proposalId: "p-edit",
      bodyMd: words(130),
      includeAiSummary: true,
    });

    expect(prisma.proposal.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "p-edit" },
      data: expect.objectContaining({
        bodyMd: words(130),
        summary: "Updated AI summary.",
      }),
    }));

    vi.clearAllMocks();
    vi.mocked(prisma.proposal.findUnique).mockResolvedValueOnce({
      id: "p-edit",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Old title",
      bodyMd: words(130),
      summary: "Updated AI summary.",
      status: "DRAFT",
      archivedAt: null,
    } as any);
    vi.mocked(prisma.proposal.update).mockResolvedValueOnce({
      id: "p-edit",
      summary: null,
      status: "DRAFT",
    } as any);

    await updateProposal(actor, {
      workspaceId: "ws-1",
      proposalId: "p-edit",
      bodyMd: words(130),
      includeAiSummary: false,
    });

    expect(defaultModelGateway.extract).not.toHaveBeenCalled();
    expect(prisma.proposal.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        summary: null,
      }),
    }));
  });
});

describe("resolveProposal", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("requires a resolution note", async () => {
    const { resolveProposal } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    await expect(resolveProposal(actor, {
      workspaceId: "ws-1",
      proposalId: "p-1",
      outcome: "ADOPTED",
      decisionMd: "   ",
    })).rejects.toThrow("Resolution note is required.");
    expect(prisma.proposal.update).not.toHaveBeenCalled();
  });

  it("adopts an open proposal, closes the approval flow, and syncs policy corpus", async () => {
    const { appendEvents } = await import("./events");
    const { resolveProposal } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    vi.mocked(prisma.proposal.findUnique).mockResolvedValueOnce({
      id: "p-1",
      workspaceId: "ws-1",
      authorUserId: "u-2",
      title: "Async standup policy",
      bodyMd: "Body",
      circleId: "circle-1",
      status: "OPEN",
      publishedAt: new Date("2026-05-01T12:00:00.000Z"),
    } as any);
    vi.mocked(prisma.approvalFlow.findUnique).mockResolvedValueOnce({ id: "flow-1", status: "ACTIVE" } as any);
    vi.mocked(prisma.proposal.update).mockResolvedValueOnce({
      id: "p-1",
      workspaceId: "ws-1",
      title: "Async standup policy",
      bodyMd: "Body",
      circleId: "circle-1",
      status: "RESOLVED",
      resolutionOutcome: "ADOPTED",
      decisionMd: "Consent round completed.",
      decidedAt: new Date("2026-05-02T12:00:00.000Z"),
    } as any);

    await expect(resolveProposal(actor, {
      workspaceId: "ws-1",
      proposalId: "p-1",
      outcome: "ADOPTED",
      decisionMd: "Consent round completed.",
    })).resolves.toMatchObject({
      id: "p-1",
      status: "RESOLVED",
      resolutionOutcome: "ADOPTED",
    });

    expect(prisma.proposal.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "p-1" },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolutionOutcome: "ADOPTED",
        decisionMd: "Consent round completed.",
        autoApproveAt: null,
        isPrivate: false,
      }),
    }));
    expect(prisma.approvalFlow.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "flow-1" },
      data: expect.objectContaining({
        status: "APPROVED",
        closedAt: expect.any(Date),
      }),
    }));
    expect(prisma.policyCorpus.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { proposalId: "p-1" },
    }));
    expect(appendEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          type: "proposal.approved",
          payload: expect.objectContaining({ subjectId: "p-1", outcome: "ADOPTED" }),
        }),
      ]),
    );
  });

  it("resolves a non-adopted proposal without creating policy corpus", async () => {
    const { appendEvents } = await import("./events");
    const { resolveProposal } = await import("./proposals");
    const actor = { kind: "agent", authProvider: "bootstrap" } as any;

    vi.mocked(prisma.proposal.findUnique).mockResolvedValueOnce({
      id: "p-2",
      workspaceId: "ws-1",
      title: "Do not adopt",
      bodyMd: "Body",
      status: "OPEN",
      publishedAt: null,
    } as any);
    vi.mocked(prisma.approvalFlow.findUnique).mockResolvedValueOnce({ id: "flow-2", status: "ACTIVE" } as any);
    vi.mocked(prisma.proposal.update).mockResolvedValueOnce({
      id: "p-2",
      status: "RESOLVED",
      resolutionOutcome: "NOT_ADOPTED",
    } as any);

    await resolveProposal(actor, {
      workspaceId: "ws-1",
      proposalId: "p-2",
      outcome: "NOT_ADOPTED",
      decisionMd: "Open objections changed the decision.",
    });

    expect(prisma.approvalFlow.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "flow-2" },
      data: expect.objectContaining({ status: "REJECTED" }),
    }));
    expect(prisma.policyCorpus.upsert).not.toHaveBeenCalled();
    expect(appendEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          type: "proposal.rejected",
          payload: expect.objectContaining({ subjectId: "p-2", outcome: "NOT_ADOPTED" }),
        }),
      ]),
    );
  });

  it("withdraws an open proposal without creating policy corpus", async () => {
    const { resolveProposal } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    vi.mocked(prisma.proposal.findUnique).mockResolvedValueOnce({
      id: "p-3",
      workspaceId: "ws-1",
      title: "Withdraw this",
      bodyMd: "Body",
      status: "OPEN",
      publishedAt: null,
    } as any);
    vi.mocked(prisma.approvalFlow.findUnique).mockResolvedValueOnce({ id: "flow-3", status: "ACTIVE" } as any);
    vi.mocked(prisma.proposal.update).mockResolvedValueOnce({
      id: "p-3",
      status: "RESOLVED",
      resolutionOutcome: "WITHDRAWN",
    } as any);

    await resolveProposal(actor, {
      workspaceId: "ws-1",
      proposalId: "p-3",
      outcome: "WITHDRAWN",
      decisionMd: "Author withdrew after discussion.",
    });

    expect(prisma.approvalFlow.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "flow-3" },
      data: expect.objectContaining({ status: "WITHDRAWN" }),
    }));
    expect(prisma.policyCorpus.upsert).not.toHaveBeenCalled();
  });
});

describe("getProposal", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("applies the privacy filter to direct proposal lookups", async () => {
    const { getProposal } = await import("./proposals");
    const { requireWorkspaceMembership } = await import("./auth");

    vi.mocked(prisma.proposal.findFirst).mockResolvedValueOnce({
      id: "p-private",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Private proposal",
      bodyMd: "Body",
      isPrivate: true,
    } as any);

    const actor = { kind: "user", user: { id: "u-1" } } as any;
    await getProposal(actor, { workspaceId: "ws-1", proposalId: "p-private" });

    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor,
      workspaceId: "ws-1",
    });
    expect(prisma.proposal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "p-private",
        workspaceId: "ws-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
        ],
      },
    }));
  });

  it("does not expose private proposals to non-authors by direct id", async () => {
    const { getProposal } = await import("./proposals");

    vi.mocked(prisma.proposal.findFirst).mockResolvedValueOnce(null);

    const actor = { kind: "user", user: { id: "u-2" } } as any;
    await expect(getProposal(actor, { workspaceId: "ws-1", proposalId: "p-private" })).rejects.toThrow("Proposal not found.");
  });

  it("lets workspace admins see private proposal drafts", async () => {
    const { getProposal } = await import("./proposals");
    const { requireWorkspaceMembership } = await import("./auth");

    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
      id: "mem-admin",
      workspaceId: "ws-1",
      userId: "u-admin",
      role: "ADMIN",
      isActive: true,
    } as any);
    vi.mocked(prisma.proposal.findFirst).mockResolvedValueOnce({
      id: "p-private",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Private proposal",
      bodyMd: "Body",
      isPrivate: true,
      status: "DRAFT",
    } as any);

    const actor = { kind: "user", user: { id: "u-admin", globalRole: "USER" } } as any;
    await expect(getProposal(actor, { workspaceId: "ws-1", proposalId: "p-private" })).resolves.toMatchObject({
      id: "p-private",
    });

    expect(prisma.proposal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "p-private",
        workspaceId: "ws-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT" },
        ],
      },
    }));
  });
});

describe("createProposalFromTension", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("creates a private draft proposal from a visible tension, links the tension, and leaves tension status unchanged", async () => {
    const { createProposalFromTension } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    vi.mocked(prisma.tension.findFirst).mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Reimbursements are slow",
      bodyMd: "The current flow takes two weeks.",
      circleId: "circle-1",
      meetingId: null,
      proposalId: null,
      status: "OPEN",
    } as any);
    vi.mocked(prisma.proposal.create).mockResolvedValueOnce({
      id: "p-1",
      workspaceId: "ws-1",
      title: "Resolve tension: Reimbursements are slow",
      bodyMd: "Draft body",
      status: "DRAFT",
      isPrivate: true,
    } as any);
    vi.mocked(prisma.tension.update).mockResolvedValueOnce({ id: "t-1", proposalId: "p-1" } as any);

    await expect(createProposalFromTension(actor, {
      workspaceId: "ws-1",
      sourceTensionId: "t-1",
    })).resolves.toMatchObject({
      id: "p-1",
      status: "DRAFT",
      isPrivate: true,
    });

    expect(prisma.tension.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "t-1",
        workspaceId: "ws-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
        ],
      }),
    }));
    expect(prisma.proposal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        authorUserId: "u-1",
        title: "Resolve tension: Reimbursements are slow",
        summary: "Proposal drafted from tension: Reimbursements are slow",
        bodyMd: expect.stringContaining("The current flow takes two weeks."),
        circleId: "circle-1",
        isPrivate: true,
        publishedAt: null,
      }),
    });
    expect(prisma.tension.update).toHaveBeenCalledWith({
      where: { id: "t-1" },
      data: { proposalId: "p-1" },
    });
  });

  it("links selected same-workspace actions to the drafted proposal", async () => {
    const { createProposalFromTension } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    vi.mocked(prisma.tension.findFirst).mockResolvedValueOnce({
      id: "t-1",
      title: "Clarify policy",
      bodyMd: null,
      circleId: null,
      meetingId: null,
      proposalId: null,
    } as any);
    vi.mocked(prisma.action.findMany).mockResolvedValueOnce([
      { id: "a-1", proposalId: null },
      { id: "a-2", proposalId: null },
    ] as any);
    vi.mocked(prisma.proposal.create).mockResolvedValueOnce({ id: "p-2", title: "Resolve tension: Clarify policy" } as any);
    vi.mocked(prisma.tension.update).mockResolvedValueOnce({ id: "t-1", proposalId: "p-2" } as any);
    vi.mocked(prisma.action.updateMany).mockResolvedValueOnce({ count: 2 } as any);

    await createProposalFromTension(actor, {
      workspaceId: "ws-1",
      sourceTensionId: "t-1",
      relatedActionIds: ["a-1", "a-2"],
    });

    expect(prisma.action.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["a-1", "a-2"] },
        workspaceId: "ws-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
        ],
      },
      select: {
        id: true,
        proposalId: true,
      },
    });
    expect(prisma.action.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["a-1", "a-2"] },
        workspaceId: "ws-1",
        archivedAt: null,
        proposalId: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
        ],
      },
      data: { proposalId: "p-2" },
    });
  });

  it("rejects missing, hidden, archived, or cross-workspace source tensions", async () => {
    const { createProposalFromTension } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    vi.mocked(prisma.tension.findFirst).mockResolvedValueOnce(null);

    await expect(createProposalFromTension(actor, {
      workspaceId: "ws-1",
      sourceTensionId: "t-missing",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    expect(prisma.proposal.create).not.toHaveBeenCalled();
  });

  it("rejects hidden, missing, archived, or cross-workspace related actions", async () => {
    const { createProposalFromTension } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    vi.mocked(prisma.tension.findFirst).mockResolvedValueOnce({
      id: "t-1",
      title: "Clarify policy",
      bodyMd: null,
      circleId: null,
      meetingId: null,
      proposalId: null,
    } as any);
    vi.mocked(prisma.action.findMany).mockResolvedValueOnce([{ id: "a-1", proposalId: null }] as any);

    await expect(createProposalFromTension(actor, {
      workspaceId: "ws-1",
      sourceTensionId: "t-1",
      relatedActionIds: ["a-1", "a-missing"],
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    expect(prisma.proposal.create).not.toHaveBeenCalled();
  });
});

describe("submitProposal event payload", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("emits proposal.opened event with title in the payload", async () => {
    const { appendEvents } = await import("./events");

    // Mock findUnique used inside submitProposal to fetch the draft
    (prisma.proposal as any).findUnique = vi.fn().mockResolvedValue({
      id: "p-1",
      workspaceId: "ws-1",
      title: "Adopt async standup policy",
      authorUserId: "u-1",
      status: "DRAFT",
      archivedAt: null,
    });

    (prisma.proposal as any).update = vi.fn().mockResolvedValue({
      id: "p-1",
      status: "OPEN",
    });
    vi.mocked((prisma as any).approvalFlow.update).mockResolvedValue({});

    const { submitProposal } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    await submitProposal(actor, {
      workspaceId: "ws-1",
      proposalId: "p-1",
    });

    expect(appendEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          type: "proposal.opened",
          payload: expect.objectContaining({
            title: "Adopt async standup policy",
          }),
        }),
      ]),
    );
  });

  it("returns an open proposal to draft and clears stale approval state", async () => {
    const { appendEvents } = await import("./events");
    const { returnProposalToDraft } = await import("./proposals");

    (prisma.proposal as any).findUnique = vi.fn().mockResolvedValue({
      id: "p-1",
      workspaceId: "ws-1",
      title: "Adopt async standup policy",
      authorUserId: "u-1",
      status: "OPEN",
      archivedAt: null,
    });
    vi.mocked((prisma as any).approvalFlow.findUnique).mockResolvedValue({ id: "flow-1" });
    vi.mocked((prisma as any).approvalDecision.deleteMany).mockResolvedValue({ count: 2 });
    vi.mocked((prisma as any).objection.deleteMany).mockResolvedValue({ count: 1 });
    vi.mocked((prisma as any).approvalFlow.update).mockResolvedValue({});
    vi.mocked((prisma as any).deliberationEntry.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked((prisma as any).proposalReaction.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked((prisma.proposal as any).update).mockResolvedValue({
      id: "p-1",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
      autoApproveAt: null,
    });

    const actor = { kind: "user", user: { id: "u-1" } } as any;
    await expect(returnProposalToDraft(actor, {
      workspaceId: "ws-1",
      proposalId: "p-1",
    })).resolves.toMatchObject({
      id: "p-1",
      status: "DRAFT",
      isPrivate: true,
    });

    expect((prisma as any).approvalDecision.deleteMany).toHaveBeenCalledWith({ where: { flowId: "flow-1" } });
    expect((prisma as any).objection.deleteMany).toHaveBeenCalledWith({ where: { flowId: "flow-1" } });
    expect((prisma as any).approvalFlow.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "flow-1" },
      data: expect.objectContaining({
        status: "DRAFT",
        openedAt: null,
        closesAt: null,
        closedAt: null,
      }),
    }));
    expect((prisma.proposal as any).update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "p-1" },
      data: expect.objectContaining({
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        autoApproveAt: null,
      }),
    }));
    expect(appendEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ type: "proposal.returned_to_draft" }),
      ]),
    );
  });
});
