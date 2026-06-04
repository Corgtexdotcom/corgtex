import { afterEach, describe, expect, it, vi } from "vitest";

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

const archiveProposal = vi.fn();
const createProposal = vi.fn();
const createProposalFromTension = vi.fn();
const enforceDemoGuard = vi.fn();
const executeAdviceProcessDecision = vi.fn();
const initiateAdviceProcess = vi.fn();
const postDeliberationEntry = vi.fn();
const postReaction = vi.fn();
const publishProposal = vi.fn();
const recordAdvice = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const resolveDeliberationEntry = vi.fn();
const resolveProposal = vi.fn();
const resolveReaction = vi.fn();
const returnProposalToDraft = vi.fn();
const submitProposal = vi.fn();
const updateProposal = vi.fn();
const withdrawAdviceProcess = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  archiveProposal,
  createProposal,
  createProposalFromTension,
  executeAdviceProcessDecision,
  initiateAdviceProcess,
  postDeliberationEntry,
  postReaction,
  publishProposal,
  recordAdvice,
  resolveDeliberationEntry,
  resolveProposal,
  resolveReaction,
  returnProposalToDraft,
  submitProposal,
  updateProposal,
  withdrawAdviceProcess,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("proposal server actions", () => {
  it("passes source tension and related action metadata when creating a proposal", async () => {
    const { createProposalAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("title", "Clarify approval policy");
    formData.set("bodyMd", "Proposal body");
    formData.set("sourceTensionId", "tension-1");
    formData.append("relatedActionIds", "action-1");
    formData.append("relatedActionIds", "action-2");

    await createProposalAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(createProposal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Clarify approval policy",
      bodyMd: "Proposal body",
      includeAiSummary: false,
      isPrivate: false,
      sourceTensionId: "tension-1",
      relatedActionIds: ["action-1", "action-2"],
    }));
    expect(createProposal.mock.calls[0]?.[1]).not.toHaveProperty("summary");
  });

  it("passes checked private proposal form state through explicitly", async () => {
    const { createProposalAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("title", "Clarify approval policy");
    formData.set("bodyMd", "Proposal body");
    formData.set("isPrivate", "on");

    await createProposalAction(formData);

    expect(createProposal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      isPrivate: true,
    }));
  });

  it("drafts a proposal from a tension through the dedicated server action", async () => {
    const { createProposalFromTensionAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("sourceTensionId", "tension-1");

    await createProposalFromTensionAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(createProposalFromTension).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      sourceTensionId: "tension-1",
      relatedActionIds: [],
      isPrivate: true,
    }));
  });

  it("passes false when the AI summary toggle was rendered but unchecked", async () => {
    const { updateProposalAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("proposalId", "proposal-1");
    formData.set("title", "Clarify approval policy");
    formData.set("bodyMd", "Long proposal body");
    formData.set("includeAiSummaryRendered", "1");

    await updateProposalAction(formData);

    expect(updateProposal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
      includeAiSummary: false,
    }));
  });
});
