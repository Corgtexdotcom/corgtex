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

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
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
