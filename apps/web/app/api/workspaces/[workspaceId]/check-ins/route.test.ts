import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCheckInsPage: vi.fn(),
  respondToCheckIn: vi.fn(),
  skipCompanyUnderstandingQuestion: vi.fn(),
  startCompanyUnderstandingQuestionConversation: vi.fn(),
  actor: { kind: "user" as const, user: { id: "user-1", email: "user@example.test", displayName: "User", globalRole: "USER" } },
}));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: async () => mocks.actor }));
vi.mock("@corgtex/domain", () => mocks);
function context() { return { params: Promise.resolve({ workspaceId: "workspace-1" }) }; }

describe("GET /api/workspaces/[workspaceId]/check-ins", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.listCheckInsPage.mockResolvedValue({ checkIns: [], nextCursor: null }); });

  it("serializes the domain's admitted page and last-examined continuation", async () => {
    const page = { checkIns: [{ id: "visible" }], nextCursor: "last-examined" };
    mocks.listCheckInsPage.mockResolvedValueOnce(page);
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/workspaces/workspace-1/check-ins"), context());
    expect(await response.json()).toEqual(page);
    expect(mocks.listCheckInsPage).toHaveBeenCalledWith(mocks.actor, { workspaceId: "workspace-1", take: 50, cursor: null });
  });

  it("clamps requested take and forwards the cursor to the scoped domain boundary", async () => {
    const { GET } = await import("./route");
    await GET(new NextRequest("http://localhost/api/workspaces/workspace-1/check-ins?take=500&cursor=checkin-10"), context());
    expect(mocks.listCheckInsPage).toHaveBeenCalledWith(mocks.actor, { workspaceId: "workspace-1", take: 100, cursor: "checkin-10" });
  });

  it("preserves a hidden-only page's continuation instead of claiming exhausted history", async () => {
    mocks.listCheckInsPage.mockResolvedValueOnce({ checkIns: [], nextCursor: "hidden-last" });
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/workspaces/workspace-1/check-ins"), context());
    expect(await response.json()).toEqual({ checkIns: [], nextCursor: "hidden-last" });
  });
});
