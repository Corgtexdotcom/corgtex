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

const addKeyResult = vi.fn();
const createGoal = vi.fn();
const deleteGoal = vi.fn();
const enforceDemoGuard = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const requireWorkspaceFeature = vi.fn();
const respondToCheckIn = vi.fn();
const returnGoalToDraft = vi.fn();
const skipCompanyUnderstandingQuestion = vi.fn();
const triggerAgentRun = vi.fn();
const updateGoal = vi.fn();
const revalidatePath = vi.fn();

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
  AppError: MockAppError,
  addKeyResult,
  createGoal,
  deleteGoal,
  respondToCheckIn,
  returnGoalToDraft,
  skipCompanyUnderstandingQuestion,
  triggerAgentRun,
  updateGoal,
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function buildEditFormData(expectedVersion = "6") {
  const formData = new FormData();
  formData.set("workspaceId", "workspace-1");
  formData.set("goalId", "goal-1");
  formData.set("expectedVersion", expectedVersion);
  formData.set("title", "Grow synthetic adoption");
  formData.set("descriptionMd", "Preserved local Goal draft");
  formData.set("cadence", "QUARTERLY");
  formData.set("level", "COMPANY");
  formData.set("startDate", "2030-01-01");
  formData.set("targetDate", "2030-03-31");
  formData.set("parentGoalId", "parent-goal");
  formData.set("circleId", "circle-1");
  formData.set("ownerMemberId", "member-1");
  return formData;
}

describe("goals server actions", () => {
  it("passes the exact rendered version and reports Goal edit success only after revalidation", async () => {
    const { editGoalFormAction } = await import("./actions");

    const result = await editGoalFormAction({ status: "idle" }, buildEditFormData());

    expect(updateGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      goalId: "goal-1",
      expectedVersion: 6,
      title: "Grow synthetic adoption",
      descriptionMd: "Preserved local Goal draft",
      cadence: "QUARTERLY",
      level: "COMPANY",
      startDate: new Date("2030-01-01"),
      targetDate: new Date("2030-03-31"),
      parentGoalId: "parent-goal",
      circleId: "circle-1",
      ownerMemberId: "member-1",
    }));
    expect(revalidatePath).toHaveBeenCalled();
    expect(updateGoal.mock.invocationCallOrder[0]).toBeLessThan(revalidatePath.mock.invocationCallOrder[0]);
    expect(result).toEqual({ status: "success" });
  });

  it.each(["", "0", "-1", "1.5", "6x", "9007199254740992"])(
    "rejects invalid Goal edit version %j without calling the writer",
    async (expectedVersion) => {
      const { editGoalFormAction } = await import("./actions");

      await expect(editGoalFormAction({ status: "idle" }, buildEditFormData(expectedVersion))).rejects.toMatchObject({
        status: 400,
        code: "INVALID_INPUT",
      });
      expect(updateGoal).not.toHaveBeenCalled();
    },
  );

  it("returns safe conflict state for a stale Goal edit without revalidation", async () => {
    updateGoal.mockRejectedValueOnce(new MockAppError(409, "VERSION_CONFLICT", "internal detail"));
    const { editGoalFormAction } = await import("./actions");

    await expect(editGoalFormAction({ status: "idle" }, buildEditFormData())).resolves.toEqual({ status: "conflict" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not swallow Goal edit permission errors", async () => {
    const error = new MockAppError(403, "FORBIDDEN", "No access");
    updateGoal.mockRejectedValueOnce(error);
    const { editGoalFormAction } = await import("./actions");

    await expect(editGoalFormAction({ status: "idle" }, buildEditFormData())).rejects.toBe(error);
  });

  it("keeps Goal lifecycle and progress updates version-optional", async () => {
    const { updateGoalFormAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("goalId", "goal-1");
    formData.set("status", "ON_TRACK");
    formData.set("progressPercent", "60");

    await updateGoalFormAction(formData);

    const payload = updateGoal.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ workspaceId: "workspace-1", goalId: "goal-1", status: "ON_TRACK", progressPercent: 60 });
    expect(payload).not.toHaveProperty("expectedVersion");
  });

  it("keeps legacy status submissions public when no draft/open intent is provided", async () => {
    const { createGoalFormAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("title", "Launch customer onboarding");
    formData.set("cadence", "QUARTERLY");
    formData.set("level", "COMPANY");
    formData.set("status", "ACTIVE");

    await createGoalFormAction(formData);

    expect(createGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Launch customer onboarding",
      cadence: "QUARTERLY",
      level: "COMPANY",
      status: "ACTIVE",
      isPrivate: false,
    }));
  });

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
