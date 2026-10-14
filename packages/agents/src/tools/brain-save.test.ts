import { beforeEach, describe, expect, it, vi } from "vitest";

const { ingestConversationOnDemandMock } = vi.hoisted(() => ({ ingestConversationOnDemandMock: vi.fn() }));

class TestAppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

vi.mock("@corgtex/domain", () => ({
  AppError: TestAppError,
  ingestConversationOnDemand: ingestConversationOnDemandMock,
}));

describe("save_to_brain", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("requires authenticated UI consent instead of accepting model-selected content", async () => {
    const { saveToBrainAction } = await import("./brain-save");
    ingestConversationOnDemandMock.mockRejectedValue(new TestAppError(409, "UNKNOWN_LINEAGE", "Unverified inputs"));

    const result = await saveToBrainAction({ kind: "user", user: { id: "u-1" } } as any,
      { workspaceId: "ws-1" }, { title: "Notes", content: "Synthetic text" });

    expect(result).toMatchObject({ success: false });
    expect(result.message).toContain("Only your confirmation");
    expect(ingestConversationOnDemandMock).not.toHaveBeenCalled();
  });
});
