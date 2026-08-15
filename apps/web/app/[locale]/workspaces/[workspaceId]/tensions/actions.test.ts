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

const createProposalFromTension = vi.fn();
const createAdviceRequest = vi.fn();
const createTension = vi.fn();
const deleteTension = vi.fn();
const enforceDemoGuard = vi.fn();
const postDeliberationEntry = vi.fn();
const publishTension = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const resolveDeliberationEntry = vi.fn();
const returnTensionToDraft = vi.fn();
const updateDeliberationEntry = vi.fn();
const updateTension = vi.fn();
const upvoteTension = vi.fn();
const uploadWorkItemEvidenceDocument = vi.fn(async () => []);
const revalidatePath = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  createAdviceRequest,
  createProposalFromTension,
  createTension,
  deleteTension,
  postDeliberationEntry,
  publishTension,
  resolveDeliberationEntry,
  returnTensionToDraft,
  updateDeliberationEntry,
  updateTension,
  upvoteTension,
}));

vi.mock("../work-item-evidence-upload", () => ({
  uploadWorkItemEvidenceDocument,
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("tension server actions", () => {
  function editForm(expectedVersion = "7") {
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("tensionId", "tension-1");
    formData.set("expectedVersion", expectedVersion);
    formData.set("title", "Updated tension");
    formData.set("bodyMd", "Preserved draft");
    return formData;
  }

  it("passes the exact rendered version and reports success only after revalidation", async () => {
    const { editTensionAction } = await import("./actions");

    const result = await editTensionAction({ status: "idle" }, editForm());

    expect(updateTension).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      tensionId: "tension-1",
      expectedVersion: 7,
      title: "Updated tension",
      bodyMd: "Preserved draft",
    }));
    expect(revalidatePath).toHaveBeenCalled();
    expect(updateTension.mock.invocationCallOrder[0]).toBeLessThan(revalidatePath.mock.invocationCallOrder[0]);
    expect(result).toEqual({ status: "success" });
  });

  it.each(["", "0", "-1", "1.5", "7x", "9007199254740992"])(
    "rejects invalid expected version %j without calling the writer",
    async (expectedVersion) => {
      const { editTensionAction } = await import("./actions");

      await expect(editTensionAction({ status: "idle" }, editForm(expectedVersion))).rejects.toMatchObject({
        status: 400,
        code: "INVALID_INPUT",
      });
      expect(updateTension).not.toHaveBeenCalled();
    },
  );

  it("returns only safe conflict state for a stale edit without revalidation", async () => {
    updateTension.mockRejectedValueOnce(new MockAppError(409, "VERSION_CONFLICT", "internal detail"));
    const { editTensionAction } = await import("./actions");

    await expect(editTensionAction({ status: "idle" }, editForm())).resolves.toEqual({ status: "conflict" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not swallow permission or unrelated domain errors", async () => {
    const error = new MockAppError(403, "FORBIDDEN", "No access");
    updateTension.mockRejectedValueOnce(error);
    const { editTensionAction } = await import("./actions");

    await expect(editTensionAction({ status: "idle" }, editForm())).rejects.toBe(error);
  });

  it("passes priority when creating a draft tension", async () => {
    const { createTensionAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("title", "Clarify handoff");
    formData.set("bodyMd", "Details");
    formData.set("priority", "5");
    formData.set("assigneeMemberId", "member-2");
    formData.set("raisedByMemberId", "member-1");
    formData.set("isPrivate", "on");

    await createTensionAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(createTension).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Clarify handoff",
      bodyMd: "Details",
      priority: 5,
      assigneeMemberId: "member-2",
      raisedByMemberId: "member-1",
      isPrivate: true,
    }));
  });

  it("passes responsible person updates through to the domain action", async () => {
    const { updateTensionAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("tensionId", "tension-1");
    formData.set("expectedVersion", "15");
    formData.set("assigneeMemberId", "member-2");
    formData.set("priority", "3");

    await updateTensionAction(formData);

    expect(updateTension).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      tensionId: "tension-1",
      expectedVersion: 15,
      assigneeMemberId: "member-2",
      priority: 3,
    }));
  });

  it.each(["title", "bodyMd", "circleId", "assigneeMemberId", "raisedByMemberId", "proposalId", "priority"])(
    "classifies Tension %s as content requiring an observed version",
    async (field) => {
      const { updateTensionAction } = await import("./actions");
      const formData = new FormData();
      formData.set("workspaceId", "workspace-1");
      formData.set("tensionId", "tension-1");
      formData.set(field, "content-value");

      await expect(updateTensionAction(formData)).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
      expect(enforceDemoGuard).not.toHaveBeenCalled();
      expect(requirePageActor).not.toHaveBeenCalled();
      expect(updateTension).not.toHaveBeenCalled();
      expect(uploadWorkItemEvidenceDocument).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "0", "-1", "1.5", "7x", "9007199254740992"])(
    "rejects generic Tension content version %j before every side effect",
    async (expectedVersion) => {
      const { updateTensionAction } = await import("./actions");
      const formData = new FormData();
      formData.set("workspaceId", "workspace-1");
      formData.set("tensionId", "tension-1");
      formData.set("title", "Content edit");
      formData.set("status", "RESOLVED");
      if (expectedVersion !== undefined) formData.set("expectedVersion", expectedVersion);

      await expect(updateTensionAction(formData)).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
      expect(enforceDemoGuard).not.toHaveBeenCalled();
      expect(requirePageActor).not.toHaveBeenCalled();
      expect(updateTension).not.toHaveBeenCalled();
      expect(uploadWorkItemEvidenceDocument).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("keeps Tension resolution-only updates unversioned", async () => {
    const { updateTensionAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("tensionId", "tension-1");
    formData.set("status", "RESOLVED");
    formData.set("resolvedVia", "Synthetic evidence");

    await updateTensionAction(formData);

    expect(uploadWorkItemEvidenceDocument).toHaveBeenCalled();
    expect(updateTension.mock.calls[0]?.[1]).not.toHaveProperty("expectedVersion");
  });

  it("creates selected-person input requests for open tensions", async () => {
    const { requestTensionInputAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("tensionId", "tension-1");
    formData.set("audienceType", "MEMBERS");
    formData.append("memberIds", "member-1");
    formData.append("memberIds", "member-2");
    formData.set("messageMd", "Please advise on sequencing.");
    formData.set("deadlineAt", "2026-07-01T10:30:00.000Z");
    formData.set("reminderAt", "2026-06-30T10:30:00.000Z");
    formData.set("preferredChannel", "SLACK");

    await requestTensionInputAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(createAdviceRequest).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      subjectType: "TENSION",
      subjectId: "tension-1",
      audienceType: "MEMBERS",
      memberIds: ["member-1", "member-2"],
      targetCircleId: null,
      messageMd: "Please advise on sequencing.",
      preferredChannel: "SLACK",
    }));
    const payload = createAdviceRequest.mock.calls[0][1];
    expect(payload.deadlineAt.toISOString()).toBe("2026-07-01T10:30:00.000Z");
    expect(payload.reminderAt.toISOString()).toBe("2026-06-30T10:30:00.000Z");
  });

  it("creates circle input requests without selected recipients", async () => {
    const { requestTensionInputAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("tensionId", "tension-1");
    formData.set("audienceType", "CIRCLE");
    formData.set("memberIds", "member-ignored");
    formData.set("targetCircleId", "circle-1");
    formData.set("messageMd", "Please advise as a circle.");

    await requestTensionInputAction(formData);

    expect(createAdviceRequest).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      subjectType: "TENSION",
      subjectId: "tension-1",
      audienceType: "CIRCLE",
      memberIds: [],
      targetCircleId: "circle-1",
      messageMd: "Please advise as a circle.",
      preferredChannel: null,
    }));
  });

  it("links deliberation replies to an input request when provided", async () => {
    const { postTensionDeliberationAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("parentId", "tension-1");
    formData.set("entryType", "REACTION");
    formData.set("bodyMd", "This sequencing looks right.");
    formData.set("adviceRequestId", "advice-request-1");

    await postTensionDeliberationAction(formData);

    expect(postDeliberationEntry).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      parentType: "TENSION",
      parentId: "tension-1",
      entryType: "REACTION",
      bodyMd: "This sequencing looks right.",
      adviceRequestId: "advice-request-1",
    }));
  });
});
