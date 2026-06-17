import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    checkIn: {
      findMany: vi.fn(),
    },
  },
}));

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

const requireWorkspaceMembership = vi.fn();
const respondToCheckIn = vi.fn();
const skipCompanyUnderstandingQuestion = vi.fn();
const startCompanyUnderstandingQuestionConversation = vi.fn();
const resolveRequestActor = vi.fn(async () => actor);

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@corgtex/domain", () => ({
  requireWorkspaceMembership,
  respondToCheckIn,
  skipCompanyUnderstandingQuestion,
  startCompanyUnderstandingQuestionConversation,
}));

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(url: string) {
  return new NextRequest(url);
}

describe("GET /api/workspaces/[workspaceId]/check-ins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });
    prismaMock.checkIn.findMany.mockResolvedValue([]);
  });

  it("returns a bounded first page with a next cursor", async () => {
    prismaMock.checkIn.findMany.mockResolvedValueOnce(
      Array.from({ length: 51 }, (_, index) => ({ id: `checkin-${index + 1}` })),
    );

    const { GET } = await import("./route");
    const response = await GET(request("http://localhost/api/workspaces/workspace-1/check-ins"), context());

    await expect(response.json()).resolves.toEqual({
      checkIns: Array.from({ length: 50 }, (_, index) => ({ id: `checkin-${index + 1}` })),
      nextCursor: "checkin-50",
    });
    expect(prismaMock.checkIn.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        memberId: "member-1",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
  });

  it("clamps take and applies the requested cursor", async () => {
    const { GET } = await import("./route");
    await GET(
      request("http://localhost/api/workspaces/workspace-1/check-ins?take=500&cursor=checkin-10"),
      context(),
    );

    expect(prismaMock.checkIn.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        memberId: "member-1",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 101,
      cursor: { id: "checkin-10" },
      skip: 1,
    });
  });

  it("does not query check-ins for agent actors without a member record", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce(null);

    const { GET } = await import("./route");
    const response = await GET(request("http://localhost/api/workspaces/workspace-1/check-ins"), context());

    await expect(response.json()).resolves.toEqual({ checkIns: [], nextCursor: null });
    expect(prismaMock.checkIn.findMany).not.toHaveBeenCalled();
  });
});
