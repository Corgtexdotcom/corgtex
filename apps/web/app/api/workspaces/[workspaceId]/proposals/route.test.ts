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

const createProposal = vi.fn();
const createProposalFromTension = vi.fn();
const coerceWorkItemPriorityInput = vi.fn((input: unknown) => {
  if (input === "Urgent" || input === 3) return 3;
  if (input === "Important" || input === 2) return 2;
  if (input === "Medium" || input === 1) return 1;
  if (input === "Low" || input === 0) return 0;
  return undefined;
});
const deleteProposal = vi.fn();
const formatWorkItemPriority = vi.fn((priority: number | null | undefined) => {
  if ((priority ?? 0) >= 3) return "Urgent";
  if ((priority ?? 0) >= 2) return "Important";
  if ((priority ?? 0) >= 1) return "Medium";
  return "Low";
});
const getWorkspacePermanentPathForEntity = vi.fn(async () => null);
const listProposals = vi.fn();
const prisma = {
  proposal: {
    findFirst: vi.fn(),
  },
};
const requireWorkspaceMembership = vi.fn();
const resolveRequestActor = vi.fn(async () => actor);
const updateProposal = vi.fn();

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@corgtex/domain", () => ({
  coerceWorkItemPriorityInput,
  createProposal,
  createProposalFromTension,
  deleteProposal,
  formatWorkItemPriority,
  getWorkspacePermanentPathForEntity,
  listProposals,
  requireWorkspaceMembership,
  updateProposal,
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    APP_URL: "https://app.corgtex.com",
  },
  prisma,
}));

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

afterEach(() => {
  vi.clearAllMocks();
  getWorkspacePermanentPathForEntity.mockResolvedValue(null);
});

describe("POST /api/workspaces/[workspaceId]/proposals", () => {
  it("creates a proposal from a source tension without requiring title or body input", async () => {
    createProposalFromTension.mockResolvedValue({
      id: "proposal-1",
      title: "Resolve tension",
      status: "DRAFT",
      priority: 2,
      ownerMemberId: "member-owner",
    });
    prisma.proposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      title: "Resolve tension",
      status: "DRAFT",
      priority: 2,
      ownerMemberId: "member-owner",
      ownerMember: { id: "member-owner", user: { displayName: "Owner", email: "owner@example.test" } },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/workspaces/workspace-1/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceTensionId: "tension-1",
          relatedActionIds: ["action-1"],
          ownerMemberId: "member-owner",
          priorityLabel: "Important",
        }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(createProposalFromTension).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      sourceTensionId: "tension-1",
      relatedActionIds: ["action-1"],
      ownerMemberId: "member-owner",
      priority: 2,
    }));
    expect(createProposal).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      proposal: {
        id: "proposal-1",
        ownerMemberId: "member-owner",
        ownerMemberName: "Owner",
        owner: "Owner",
        priority: 2,
        priorityLabel: "Important",
      },
    });
  });

  it("passes owner and labeled priority into direct proposal creation", async () => {
    createProposal.mockResolvedValue({
      id: "proposal-2",
      title: "Improve follow-through",
      status: "DRAFT",
      priority: 3,
      ownerMemberId: "member-owner",
    });
    prisma.proposal.findFirst.mockResolvedValue({
      id: "proposal-2",
      title: "Improve follow-through",
      status: "DRAFT",
      priority: 3,
      ownerMemberId: "member-owner",
      ownerMember: { id: "member-owner", user: { displayName: "Owner", email: "owner@example.test" } },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/workspaces/workspace-1/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Improve follow-through",
          bodyMd: "Assign one owner.",
          ownerMemberId: "member-owner",
          priority: "Urgent",
        }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(createProposal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      ownerMemberId: "member-owner",
      priority: 3,
    }));
    await expect(response.json()).resolves.toMatchObject({
      proposal: {
        id: "proposal-2",
        ownerMemberId: "member-owner",
        ownerMemberName: "Owner",
        owner: "Owner",
        priorityLabel: "Urgent",
      },
    });
  });
});

describe("PATCH /api/workspaces/[workspaceId]/proposals/[proposalId]", () => {
  it("passes owner and labeled priority into proposal updates", async () => {
    updateProposal.mockResolvedValue({
      id: "proposal-1",
      status: "DRAFT",
      priority: 1,
      ownerMemberId: "member-owner",
    });
    prisma.proposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "DRAFT",
      priority: 1,
      ownerMemberId: "member-owner",
      ownerMember: { id: "member-owner", user: { displayName: "Owner", email: "owner@example.test" } },
    });

    const { PATCH } = await import("./[proposalId]/route");
    const response = await PATCH(
      new NextRequest("http://localhost/api/workspaces/workspace-1/proposals/proposal-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerMemberId: "member-owner",
          priorityLabel: "Medium",
        }),
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1", proposalId: "proposal-1" }) },
    );

    expect(updateProposal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
      ownerMemberId: "member-owner",
      priority: 1,
    }));
    await expect(response.json()).resolves.toMatchObject({
      proposal: {
        id: "proposal-1",
        ownerMemberId: "member-owner",
        ownerMemberName: "Owner",
        owner: "Owner",
        priority: 1,
        priorityLabel: "Medium",
      },
    });
  });
});
