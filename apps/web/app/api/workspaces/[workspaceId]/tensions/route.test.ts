import { NextRequest } from "next/server";
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

const createTension = vi.fn();
const coerceWorkItemPriorityInput = vi.fn((input: unknown) => {
  if (input === "Urgent" || input === 3) return 3;
  if (input === "Important" || input === 2) return 2;
  if (input === "Medium" || input === 1) return 1;
  if (input === "Low" || input === 0) return 0;
  return undefined;
});
const deleteTension = vi.fn();
const formatWorkItemPriority = vi.fn((priority: number | null | undefined) => {
  if ((priority ?? 0) >= 3) return "Urgent";
  if ((priority ?? 0) >= 2) return "Important";
  if ((priority ?? 0) >= 1) return "Medium";
  return "Low";
});
const getWorkspacePermanentPathForEntity = vi.fn(async () => null);
const listTensions = vi.fn();
const requireWorkspaceMembership = vi.fn();
const resolveRequestActor = vi.fn(async () => actor);
const updateTension = vi.fn();

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@corgtex/domain", () => ({
  coerceWorkItemPriorityInput,
  createTension,
  deleteTension,
  formatWorkItemPriority,
  getWorkspacePermanentPathForEntity,
  listTensions,
  requireWorkspaceMembership,
  updateTension,
}));

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

afterEach(() => {
  vi.clearAllMocks();
  getWorkspacePermanentPathForEntity.mockResolvedValue(null);
});

describe("POST /api/workspaces/[workspaceId]/tensions", () => {
  it("passes responsible person and labeled priority into tension creation", async () => {
    createTension.mockResolvedValue({
      id: "tension-1",
      title: "Clarify owner",
      status: "DRAFT",
      priority: 3,
      assigneeMemberId: "member-responsible",
      raisedByMemberId: "member-raiser",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/workspaces/workspace-1/tensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Clarify owner",
          bodyMd: "Need clear responsibility.",
          assigneeMemberId: "member-responsible",
          raisedByMemberId: "member-raiser",
          priorityLabel: "Urgent",
        }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(createTension).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      assigneeMemberId: "member-responsible",
      raisedByMemberId: "member-raiser",
      priority: 3,
    }));
    await expect(response.json()).resolves.toMatchObject({
      tension: {
        id: "tension-1",
        priorityLabel: "Urgent",
        responsibleMemberId: "member-responsible",
        raisedByMemberId: "member-raiser",
      },
    });
  });
});

describe("PATCH /api/workspaces/[workspaceId]/tensions/[tensionId]", () => {
  it("passes responsible person and labeled priority into tension updates", async () => {
    updateTension.mockResolvedValue({
      id: "tension-1",
      status: "OPEN",
      priority: 2,
      assigneeMemberId: "member-responsible",
    });

    const { PATCH } = await import("./[tensionId]/route");
    const response = await PATCH(
      new NextRequest("http://localhost/api/workspaces/workspace-1/tensions/tension-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assigneeMemberId: "member-responsible",
          priority: "Important",
        }),
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1", tensionId: "tension-1" }) },
    );

    expect(updateTension).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      tensionId: "tension-1",
      assigneeMemberId: "member-responsible",
      priority: 2,
    }));
    await expect(response.json()).resolves.toMatchObject({
      tension: {
        id: "tension-1",
        priorityLabel: "Important",
        responsibleMemberId: "member-responsible",
      },
    });
  });
});
