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

class MockAppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const archiveProposal = vi.fn();
const createAdviceRequest = vi.fn();
const createProposal = vi.fn();
const createProposalFromTension = vi.fn();
const enforceDemoGuard = vi.fn();
const postDeliberationEntry = vi.fn();
const reopenProposal = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const resolveDeliberationEntry = vi.fn();
const resolveProposal = vi.fn();
const returnProposalToDraft = vi.fn();
const submitProposal = vi.fn();
const updateDeliberationEntry = vi.fn();
const updateProposal = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  archiveProposal,
  createAdviceRequest,
  createProposal,
  createProposalFromTension,
  postDeliberationEntry,
  reopenProposal,
  resolveDeliberationEntry,
  resolveProposal,
  returnProposalToDraft,
  submitProposal,
  updateDeliberationEntry,
  updateProposal,
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("proposal server actions", () => {
  function editForm(expectedVersion = "11") {
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("proposalId", "proposal-1");
    formData.set("expectedVersion", expectedVersion);
    formData.set("title", "Updated proposal");
    formData.set("bodyMd", "Preserved draft");
    return formData;
  }

  it("passes the exact rendered version and reports success only after revalidation", async () => {
    const { editProposalAction } = await import("./actions");

    const result = await editProposalAction({ status: "idle" }, editForm());

    expect(updateProposal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
      expectedVersion: 11,
      title: "Updated proposal",
      bodyMd: "Preserved draft",
    }));
    expect(revalidatePath).toHaveBeenCalled();
    expect(updateProposal.mock.invocationCallOrder[0]).toBeLessThan(revalidatePath.mock.invocationCallOrder[0]);
    expect(result).toEqual({ status: "success" });
  });

  it.each(["", "0", "-1", "1.5", "11x", "9007199254740992"])(
    "rejects invalid expected version %j without calling the writer",
    async (expectedVersion) => {
      const { editProposalAction } = await import("./actions");

      await expect(editProposalAction({ status: "idle" }, editForm(expectedVersion))).rejects.toMatchObject({
        status: 400,
        code: "INVALID_INPUT",
      });
      expect(updateProposal).not.toHaveBeenCalled();
    },
  );

  it("returns only safe conflict state for a stale edit without revalidation", async () => {
    updateProposal.mockRejectedValueOnce(new MockAppError(409, "VERSION_CONFLICT", "internal detail"));
    const { editProposalAction } = await import("./actions");

    await expect(editProposalAction({ status: "idle" }, editForm())).resolves.toEqual({ status: "conflict" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not swallow permission or unrelated domain errors", async () => {
    const error = new MockAppError(403, "FORBIDDEN", "No access");
    updateProposal.mockRejectedValueOnce(error);
    const { editProposalAction } = await import("./actions");

    await expect(editProposalAction({ status: "idle" }, editForm())).rejects.toBe(error);
  });

  it("passes source tension and related action metadata when creating a proposal", async () => {
    const { createProposalAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("title", "Clarify approval policy");
    formData.set("bodyMd", "Proposal body");
    formData.set("priority", "6");
    formData.set("ownerMemberId", "member-owner");
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
      priority: 6,
      ownerMemberId: "member-owner",
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
    expect(createProposal.mock.calls[0]?.[1]).not.toHaveProperty("ownerMemberId");
  });

  it("passes an empty proposal owner select as explicit null", async () => {
    const { createProposalAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("title", "Clarify approval policy");
    formData.set("bodyMd", "Proposal body");
    formData.set("ownerMemberId", "");

    await createProposalAction(formData);

    expect(createProposal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      ownerMemberId: null,
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
    expect(createProposalFromTension.mock.calls[0]?.[1]).not.toHaveProperty("ownerMemberId");
  });

  it("passes false when the AI summary toggle was rendered but unchecked", async () => {
    const { updateProposalAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("proposalId", "proposal-1");
    formData.set("title", "Clarify approval policy");
    formData.set("bodyMd", "Long proposal body");
    formData.set("ownerMemberId", "member-owner");
    formData.set("includeAiSummaryRendered", "1");

    await updateProposalAction(formData);

    expect(updateProposal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
      ownerMemberId: "member-owner",
      includeAiSummary: false,
    }));
  });

  it("creates a generic proposal advice request for selected members", async () => {
    const { requestProposalAdviceAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("proposalId", "proposal-1");
    formData.set("audienceType", "MEMBERS");
    formData.append("memberIds", "member-1");
    formData.append("memberIds", "member-2");
    formData.set("targetCircleId", "circle-ignored");
    formData.set("messageMd", "Please advise on the rollout risk.");
    formData.set("deadlineAt", "2030-01-02T03:04");
    formData.set("reminderAt", "2030-01-01T03:04");
    formData.set("preferredChannel", "SLACK");

    await requestProposalAdviceAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(createAdviceRequest).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      subjectType: "PROPOSAL",
      subjectId: "proposal-1",
      audienceType: "MEMBERS",
      memberIds: ["member-1", "member-2"],
      targetCircleId: null,
      messageMd: "Please advise on the rollout risk.",
      preferredChannel: "SLACK",
    }));
    const payload = createAdviceRequest.mock.calls[0][1];
    expect(payload.deadlineAt).toEqual(new Date("2030-01-02T03:04"));
    expect(payload.reminderAt).toEqual(new Date("2030-01-01T03:04"));
  });

  it("creates a generic proposal advice request for a circle audience", async () => {
    const { requestProposalAdviceAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("proposalId", "proposal-1");
    formData.set("audienceType", "CIRCLE");
    formData.append("memberIds", "member-ignored");
    formData.set("targetCircleId", "circle-1");
    formData.set("messageMd", "Please advise on circle impact.");

    await requestProposalAdviceAction(formData);

    expect(createAdviceRequest).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      subjectType: "PROPOSAL",
      subjectId: "proposal-1",
      audienceType: "CIRCLE",
      memberIds: [],
      targetCircleId: "circle-1",
      messageMd: "Please advise on circle impact.",
      deadlineAt: null,
      reminderAt: null,
      preferredChannel: null,
    }));
  });

  it("links proposal deliberation replies to an advice request", async () => {
    const { postDeliberationEntryAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("proposalId", "proposal-1");
    formData.set("entryType", "REACTION");
    formData.set("bodyMd", "This looks safe to try.");
    formData.set("adviceRequestId", "request-1");

    await postDeliberationEntryAction(formData);

    expect(postDeliberationEntry).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      parentType: "PROPOSAL",
      parentId: "proposal-1",
      entryType: "REACTION",
      bodyMd: "This looks safe to try.",
      adviceRequestId: "request-1",
    }));
  });
});
