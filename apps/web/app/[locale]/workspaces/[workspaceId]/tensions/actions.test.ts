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

const createProposalFromTension = vi.fn();
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

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
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
  uploadWorkItemEvidenceDocument: vi.fn(async () => []),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("tension server actions", () => {
  it("passes priority when creating a draft tension", async () => {
    const { createTensionAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("title", "Clarify handoff");
    formData.set("bodyMd", "Details");
    formData.set("priority", "5");
    formData.set("isPrivate", "on");

    await createTensionAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(createTension).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Clarify handoff",
      bodyMd: "Details",
      priority: 5,
      isPrivate: true,
    }));
  });
});
