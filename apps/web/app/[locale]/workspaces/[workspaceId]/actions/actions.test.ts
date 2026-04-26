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
const publishAction = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const updateAction = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  createAction,
  deleteAction,
  publishAction,
  updateAction,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

function buildCreateFormData() {
  const formData = new FormData();
  formData.set("workspaceId", "workspace-1");
  formData.set("title", "Follow up");
  formData.set("bodyMd", "Notes");
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
      proposalId: null,
      isPrivate: true,
    }));
  });

  it("honors an explicit public draft control if one is later added to the form", async () => {
    const { createActionAction } = await import("./actions");
    const formData = buildCreateFormData();
    formData.set("isPrivate", "off");

    await createActionAction(formData);

    expect(createAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      isPrivate: false,
    }));
  });
});
