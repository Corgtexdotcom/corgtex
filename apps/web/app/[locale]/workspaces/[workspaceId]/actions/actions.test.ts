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
    });
  });
});
