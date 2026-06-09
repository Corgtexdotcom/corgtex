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

const addKeyResult = vi.fn();
const createGoal = vi.fn();
const createGoalLink = vi.fn();
const createRecognition = vi.fn();
const deleteGoal = vi.fn();
const deleteGoalLink = vi.fn();
const deleteKeyResult = vi.fn();
const enforceDemoGuard = vi.fn();
const postGoalUpdate = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const requireWorkspaceFeature = vi.fn();
const respondToCheckIn = vi.fn();
const returnGoalToDraft = vi.fn();
const skipCompanyUnderstandingQuestion = vi.fn();
const triggerAgentRun = vi.fn();
const updateGoal = vi.fn();
const updateKeyResult = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@/lib/workspace-feature-flags", () => ({
  requireWorkspaceFeature,
}));

vi.mock("@corgtex/domain", () => ({
  addKeyResult,
  createGoal,
  createGoalLink,
  createRecognition,
  deleteGoal,
  deleteGoalLink,
  deleteKeyResult,
  postGoalUpdate,
  respondToCheckIn,
  returnGoalToDraft,
  skipCompanyUnderstandingQuestion,
  triggerAgentRun,
  updateGoal,
  updateKeyResult,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("goals server actions", () => {
  it("queues company-understanding synthesis from the Brain refresh action", async () => {
    const { refreshCompanyDirectionFromBrainFormAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");

    await refreshCompanyDirectionFromBrainFormAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requireWorkspaceFeature).toHaveBeenCalledWith("workspace-1", "GOALS");
    expect(triggerAgentRun).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      agentKey: "company-understanding",
    });
  });

  it("answers a company-understanding question through the check-in response path", async () => {
    const { answerCompanyUnderstandingQuestionFormAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("checkInId", "checkin-1");
    formData.set("responseMd", "The operations lead owns the onboarding decision.");

    await answerCompanyUnderstandingQuestionFormAction(formData);

    expect(respondToCheckIn).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      checkInId: "checkin-1",
      responseMd: "The operations lead owns the onboarding decision.",
    });
  });

  it("skips an optional company-understanding question", async () => {
    const { skipCompanyUnderstandingQuestionFormAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("checkInId", "checkin-1");

    await skipCompanyUnderstandingQuestionFormAction(formData);

    expect(skipCompanyUnderstandingQuestion).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      checkInId: "checkin-1",
    });
  });
});
