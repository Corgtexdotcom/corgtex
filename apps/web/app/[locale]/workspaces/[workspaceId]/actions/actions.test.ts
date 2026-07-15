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

const createAdviceRequest = vi.fn();
const createAction = vi.fn();
const deleteAction = vi.fn();
const enforceDemoGuard = vi.fn();
const postDeliberationEntry = vi.fn();
const publishAction = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const resolveDeliberationEntry = vi.fn();
const returnActionToDraft = vi.fn();
const updateAction = vi.fn();
const updateDeliberationEntry = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  createAdviceRequest,
  createAction,
  deleteAction,
  postDeliberationEntry,
  publishAction,
  resolveDeliberationEntry,
  returnActionToDraft,
  updateAction,
  updateDeliberationEntry,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

function buildCreateFormData() {
  const formData = new FormData();
  formData.set("workspaceId", "workspace-1");
  formData.set("title", "Follow up");
  formData.set("bodyMd", "Notes");
  formData.set("priority", "4");
  formData.set("assigneeMemberId", "member-2");
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
      proposalId: null,
      isPrivate: true,
    }));
  });

  it("updates editable action metadata including priority and assignee", async () => {
    const { updateActionAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("actionId", "action-1");
    formData.set("title", "Close the loop");
    formData.set("bodyMd", "Follow up with Eduardo.");
    formData.set("priority", "3");
    formData.set("assigneeMemberId", "member-3");

    await updateActionAction(formData);

    expect(updateAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Close the loop",
      bodyMd: "Follow up with Eduardo.",
      priority: 3,
      assigneeMemberId: "member-3",
    }));
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
