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

const createAdviceRequest = vi.fn();
const createAction = vi.fn();
const createActionChecklistItem = vi.fn();
const deleteAction = vi.fn();
const deleteActionChecklistItem = vi.fn();
const enforceDemoGuard = vi.fn();
const postDeliberationEntry = vi.fn();
const publishAction = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const resolveDeliberationEntry = vi.fn();
const returnActionToDraft = vi.fn();
const updateAction = vi.fn();
const updateActionChecklistItem = vi.fn();
const updateDeliberationEntry = vi.fn();
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
  createAction,
  createActionChecklistItem,
  deleteAction,
  deleteActionChecklistItem,
  postDeliberationEntry,
  publishAction,
  resolveDeliberationEntry,
  returnActionToDraft,
  updateAction,
  updateActionChecklistItem,
  updateDeliberationEntry,
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("../work-item-evidence-upload", () => ({
  uploadWorkItemEvidenceDocument,
}));

function buildCreateFormData() {
  const formData = new FormData();
  formData.set("workspaceId", "workspace-1");
  formData.set("title", "Follow up");
  formData.set("bodyMd", "Notes");
  formData.set("priority", "4");
  formData.set("assigneeMemberId", "member-2");
  formData.set("dueAt", "2030-01-02");
  return formData;
}

function buildEditFormData(expectedVersion = "9") {
  const formData = new FormData();
  formData.set("workspaceId", "workspace-1");
  formData.set("actionId", "action-1");
  formData.set("expectedVersion", expectedVersion);
  formData.set("title", "Close the concurrency loop");
  formData.set("bodyMd", "Preserved local Action draft");
  formData.set("priority", "3");
  formData.set("assigneeMemberId", "member-3");
  formData.set("dueAt", "2030-02-03");
  return formData;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("action item server actions", () => {
  it("creates form-submitted actions as private drafts by default", async () => {
    const { createActionAction } = await import("./actions");

    await createActionAction(buildCreateFormData());

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(createAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Follow up",
      bodyMd: "Notes",
      priority: 4,
      assigneeMemberId: "member-2",
      dueAt: new Date("2030-01-02"),
      proposalId: null,
      isPrivate: true,
    }));
  });

  it("forwards the exact observed version for generic Action content updates", async () => {
    const { updateActionAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("actionId", "action-1");
    formData.set("expectedVersion", "12");
    formData.set("title", "Close the loop");
    formData.set("bodyMd", "Follow up with Eduardo.");
    formData.set("priority", "3");
    formData.set("assigneeMemberId", "member-3");
    formData.set("dueAt", "2030-02-03");

    await updateActionAction(formData);

    expect(updateAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      actionId: "action-1",
      expectedVersion: 12,
      title: "Close the loop",
      bodyMd: "Follow up with Eduardo.",
      priority: 3,
      assigneeMemberId: "member-3",
      dueAt: new Date("2030-02-03"),
    }));
  });

  it.each(["title", "bodyMd", "priority", "circleId", "assigneeMemberId", "dueAt", "proposalId"])(
    "classifies Action %s as content requiring an observed version",
    async (field) => {
      const { updateActionAction } = await import("./actions");
      const formData = new FormData();
      formData.set("workspaceId", "workspace-1");
      formData.set("actionId", "action-1");
      formData.set(field, "content-value");

      await expect(updateActionAction(formData)).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
      expect(enforceDemoGuard).not.toHaveBeenCalled();
      expect(requirePageActor).not.toHaveBeenCalled();
      expect(updateAction).not.toHaveBeenCalled();
      expect(uploadWorkItemEvidenceDocument).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "0", "-1", "1.5", "9x", "9007199254740992"])(
    "rejects generic Action content version %j before every side effect",
    async (expectedVersion) => {
      const { updateActionAction } = await import("./actions");
      const formData = new FormData();
      formData.set("workspaceId", "workspace-1");
      formData.set("actionId", "action-1");
      formData.set("title", "Content edit");
      formData.set("status", "COMPLETED");
      if (expectedVersion !== undefined) formData.set("expectedVersion", expectedVersion);

      await expect(updateActionAction(formData)).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
      expect(enforceDemoGuard).not.toHaveBeenCalled();
      expect(requirePageActor).not.toHaveBeenCalled();
      expect(updateAction).not.toHaveBeenCalled();
      expect(uploadWorkItemEvidenceDocument).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("passes the exact rendered version and reports edit success only after revalidation", async () => {
    const { editActionAction } = await import("./actions");

    const result = await editActionAction({ status: "idle" }, buildEditFormData());

    expect(updateAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      actionId: "action-1",
      expectedVersion: 9,
      title: "Close the concurrency loop",
      bodyMd: "Preserved local Action draft",
      priority: 3,
      assigneeMemberId: "member-3",
      dueAt: new Date("2030-02-03"),
    }));
    expect(revalidatePath).toHaveBeenCalled();
    expect(updateAction.mock.invocationCallOrder[0]).toBeLessThan(revalidatePath.mock.invocationCallOrder[0]);
    expect(result).toEqual({ status: "success" });
  });

  it.each(["", "0", "-1", "1.5", "9x", "9007199254740992"])(
    "rejects invalid Action edit version %j without calling the writer",
    async (expectedVersion) => {
      const { editActionAction } = await import("./actions");

      await expect(editActionAction({ status: "idle" }, buildEditFormData(expectedVersion))).rejects.toMatchObject({
        status: 400,
        code: "INVALID_INPUT",
      });
      expect(updateAction).not.toHaveBeenCalled();
    },
  );

  it("returns safe conflict state for a stale Action edit without revalidation", async () => {
    updateAction.mockRejectedValueOnce(new MockAppError(409, "VERSION_CONFLICT", "internal detail"));
    const { editActionAction } = await import("./actions");

    await expect(editActionAction({ status: "idle" }, buildEditFormData())).resolves.toEqual({ status: "conflict" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not swallow Action edit permission errors", async () => {
    const error = new MockAppError(403, "FORBIDDEN", "No access");
    updateAction.mockRejectedValueOnce(error);
    const { editActionAction } = await import("./actions");

    await expect(editActionAction({ status: "idle" }, buildEditFormData())).rejects.toBe(error);
  });

  it("keeps lifecycle-only Action updates version-optional", async () => {
    const { updateActionAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("actionId", "action-1");
    formData.set("status", "IN_PROGRESS");

    await updateActionAction(formData);

    const payload = updateAction.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ workspaceId: "workspace-1", actionId: "action-1", status: "IN_PROGRESS" });
    expect(payload).not.toHaveProperty("expectedVersion");
  });

  it("creates action checklist items", async () => {
    const { createActionChecklistItemAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("actionId", "action-1");
    formData.set("title", "Confirm owner");

    await createActionChecklistItemAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(createActionChecklistItem).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Confirm owner",
    });
  });

  it("updates action checklist items", async () => {
    const { updateActionChecklistItemAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("checklistItemId", "checklist-1");
    formData.set("title", "Confirm regulatory owner");
    formData.set("completed", "true");

    await updateActionChecklistItemAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(updateActionChecklistItem).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      checklistItemId: "checklist-1",
      title: "Confirm regulatory owner",
      completed: true,
    });
  });

  it("deletes action checklist items", async () => {
    const { deleteActionChecklistItemAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("checklistItemId", "checklist-1");

    await deleteActionChecklistItemAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(deleteActionChecklistItem).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      checklistItemId: "checklist-1",
    });
  });

  it("honors an explicit public create control if one is later added to the form", async () => {
    const { createActionAction } = await import("./actions");
    const formData = buildCreateFormData();
    formData.set("isPrivate", "off");

    await createActionAction(formData);

    expect(createAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      isPrivate: false,
    }));
  });

  it("posts action deliberation entries against ACTION parents", async () => {
    const { postActionDeliberationAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("parentId", "action-1");
    formData.set("entryType", "OBJECTION");
    formData.set("bodyMd", "Needs a clearer owner.");
    formData.set("targetMemberId", "member-1");

    await postActionDeliberationAction(formData);

    expect(postDeliberationEntry).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      parentType: "ACTION",
      parentId: "action-1",
      entryType: "OBJECTION",
      bodyMd: "Needs a clearer owner.",
      targetMemberId: "member-1",
      targetCircleId: undefined,
      adviceRequestId: undefined,
    });
  });

  it("creates action input requests for selected people", async () => {
    const { requestActionInputAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("actionId", "action-1");
    formData.set("audienceType", "MEMBERS");
    formData.append("memberIds", "member-1");
    formData.append("memberIds", "member-2");
    formData.set("targetCircleId", "circle-ignored");
    formData.set("messageMd", "Please confirm whether this task is blocked.");
    formData.set("deadlineAt", "2030-01-02T03:04");
    formData.set("reminderAt", "2030-01-01T03:04");
    formData.set("preferredChannel", "EMAIL");

    await requestActionInputAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(createAdviceRequest).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      subjectType: "ACTION",
      subjectId: "action-1",
      audienceType: "MEMBERS",
      memberIds: ["member-1", "member-2"],
      targetCircleId: null,
      messageMd: "Please confirm whether this task is blocked.",
      preferredChannel: "EMAIL",
    }));
    const payload = createAdviceRequest.mock.calls[0][1];
    expect(payload.deadlineAt).toEqual(new Date("2030-01-02T03:04"));
    expect(payload.reminderAt).toEqual(new Date("2030-01-01T03:04"));
  });

  it("links action replies to an input request", async () => {
    const { postActionDeliberationAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("parentId", "action-1");
    formData.set("entryType", "REACTION");
    formData.set("bodyMd", "I added the missing renewal date.");
    formData.set("adviceRequestId", "request-1");

    await postActionDeliberationAction(formData);

    expect(postDeliberationEntry).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      parentType: "ACTION",
      parentId: "action-1",
      entryType: "REACTION",
      bodyMd: "I added the missing renewal date.",
      adviceRequestId: "request-1",
    }));
  });
});
