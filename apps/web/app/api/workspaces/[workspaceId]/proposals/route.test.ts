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
const loadAdviceRequestCountSummaries = vi.fn();
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

vi.mock("@corgtex/domain", async () => {
  const {
    normalizeActionWorkItem,
    normalizeGoalWorkItem,
    normalizeProposalWorkItem,
    normalizeTensionWorkItem,
    workItemMemberDisplayName,
    workItemUserDisplayName,
  } = await import("../../../../../../../packages/domain/src/work-item-normalization");

  return {
    AppError: class AppError extends Error {
      status: number;
      code: string;

      constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
      }
    },
    coerceWorkItemPriorityInput,
    createProposal,
    createProposalFromTension,
    deleteProposal,
    formatWorkItemPriority,
    getWorkspacePermanentPathForEntity,
    loadAdviceRequestCountSummaries,
    listProposals,
    normalizeActionWorkItem,
    normalizeGoalWorkItem,
    normalizeProposalWorkItem,
    normalizeTensionWorkItem,
    requireWorkspaceMembership,
    updateProposal,
    workItemMemberDisplayName,
    workItemUserDisplayName,
  };
});

vi.mock("@corgtex/shared", () => ({
  captureErrorTelemetry: vi.fn(),
  env: {
    APP_URL: "https://app.corgtex.com",
  },
  isDatabaseUnavailableError: vi.fn(() => false),
  prisma,
}));

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function proposalPatchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/workspaces/workspace-1/proposals/proposal-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

afterEach(() => {
  vi.clearAllMocks();
  getWorkspacePermanentPathForEntity.mockResolvedValue(null);
});

describe("GET /api/workspaces/[workspaceId]/proposals", () => {
  it("caps pagination and passes archive filters into proposal listing", async () => {
    listProposals.mockResolvedValue({
      items: [],
      total: 0,
      take: 100,
      skip: 20,
    });

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost/api/workspaces/workspace-1/proposals?archiveFilter=active&take=5000&skip=20"),
      context(),
    );

    expect(response.status).toBe(200);
    expect(listProposals).toHaveBeenCalledWith(actor, "workspace-1", {
      archiveFilter: "active",
      take: 100,
      skip: 20,
    });
  });
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
          isPrivate: false,
          ownerMemberId: "member-owner",
          priority: "Urgent",
        }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(createProposal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      isPrivate: false,
      ownerMemberId: "member-owner",
      priority: 3,
    }));
    expect(prisma.proposal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        adviceProcess: {
          include: {
            requests: {
              select: { status: true },
            },
          },
        },
      }),
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

  it("omits ownerMemberId when the create body omits the owner", async () => {
    createProposal.mockResolvedValue({
      id: "proposal-3",
      title: "Default to author",
      status: "DRAFT",
      priority: 0,
      ownerMemberId: "member-default",
    });
    prisma.proposal.findFirst.mockResolvedValue({
      id: "proposal-3",
      title: "Default to author",
      status: "DRAFT",
      priority: 0,
      ownerMemberId: "member-default",
      ownerMember: { id: "member-default", user: { displayName: "Default Owner", email: "default@example.test" } },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/workspaces/workspace-1/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Default to author",
          bodyMd: "No owner field is sent.",
        }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(createProposal.mock.calls[0]?.[1]).not.toHaveProperty("ownerMemberId");
    await expect(response.json()).resolves.toMatchObject({
      proposal: {
        id: "proposal-3",
        ownerMemberId: "member-default",
        ownerMemberName: "Default Owner",
      },
    });
  });

  it("passes explicit null owner into direct proposal creation", async () => {
    createProposal.mockResolvedValue({
      id: "proposal-4",
      title: "No owner",
      status: "DRAFT",
      priority: 0,
      ownerMemberId: null,
    });
    prisma.proposal.findFirst.mockResolvedValue({
      id: "proposal-4",
      title: "No owner",
      status: "DRAFT",
      priority: 0,
      ownerMemberId: null,
      ownerMember: null,
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/workspaces/workspace-1/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "No owner",
          bodyMd: "Explicitly ownerless.",
          ownerMemberId: null,
        }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(createProposal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      ownerMemberId: null,
    }));
  });
});

describe("PATCH /api/workspaces/[workspaceId]/proposals/[proposalId]", () => {
  it("passes owner and labeled priority into proposal updates", async () => {
    updateProposal.mockResolvedValue({
      id: "proposal-1",
      status: "DRAFT",
      priority: 1,
      ownerMemberId: "member-owner",
      version: 3,
    });
    prisma.proposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "DRAFT",
      priority: 1,
      ownerMemberId: "member-owner",
      version: 3,
      ownerMember: { id: "member-owner", user: { displayName: "Owner", email: "owner@example.test" } },
    });

    const { PATCH } = await import("./[proposalId]/route");
    const response = await PATCH(
      proposalPatchRequest({
        ownerMemberId: "member-owner",
        priorityLabel: "Medium",
        expectedVersion: 2,
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1", proposalId: "proposal-1" }) },
    );

    expect(updateProposal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
      ownerMemberId: "member-owner",
      priority: 1,
      expectedVersion: 2,
    }));
    expect(prisma.proposal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        adviceProcess: {
          include: {
            requests: {
              select: { status: true },
            },
          },
        },
      }),
    }));
    await expect(response.json()).resolves.toMatchObject({
      proposal: {
        id: "proposal-1",
        ownerMemberId: "member-owner",
        ownerMemberName: "Owner",
        owner: "Owner",
        priority: 1,
        priorityLabel: "Medium",
        version: 3,
      },
    });
  });

  it.each([
    ["missing", { title: "Updated proposal" }],
    ["zero", { title: "Updated proposal", expectedVersion: 0 }],
    ["negative", { title: "Updated proposal", expectedVersion: -1 }],
    ["fractional", { title: "Updated proposal", expectedVersion: 1.5 }],
    ["non-numeric", { title: "Updated proposal", expectedVersion: "2" }],
  ])("rejects a %s expectedVersion before mutation", async (_label, body) => {
    const { PATCH } = await import("./[proposalId]/route");
    const response = await PATCH(proposalPatchRequest(body), {
      params: Promise.resolve({ workspaceId: "workspace-1", proposalId: "proposal-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(updateProposal).not.toHaveBeenCalled();
  });

  it("returns the shared safe conflict response for a stale edit", async () => {
    updateProposal.mockRejectedValueOnce(routeError(
      409,
      "VERSION_CONFLICT",
      "The record changed before this update could be applied. Please refresh and try again.",
    ));
    const { PATCH } = await import("./[proposalId]/route");
    const response = await PATCH(proposalPatchRequest({ title: "Stale title", expectedVersion: 1 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", proposalId: "proposal-1" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VERSION_CONFLICT",
        message: "The record changed before this update could be applied. Please refresh and try again.",
      },
    });
  });

  it("preserves unauthenticated behavior before domain mutation", async () => {
    resolveRequestActor.mockRejectedValueOnce(routeError(401, "UNAUTHENTICATED", "Authentication required."));
    const { PATCH } = await import("./[proposalId]/route");
    const response = await PATCH(proposalPatchRequest({ title: "Updated", expectedVersion: 2 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", proposalId: "proposal-1" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required." },
    });
    expect(updateProposal).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong-workspace, deleted, or missing records", 404, "NOT_FOUND", "Proposal not found."],
    ["unauthorized or private records", 403, "FORBIDDEN", "You do not have permission to edit this proposal."],
    ["archived records", 400, "INVALID_STATE", "Archived proposals cannot be edited."],
    ["terminal lifecycle states", 400, "INVALID_STATE", "Only draft or open proposals can be edited."],
  ])("preserves %s errors", async (_label, status, code, message) => {
    updateProposal.mockRejectedValueOnce(routeError(status as number, code as string, message as string));
    const { PATCH } = await import("./[proposalId]/route");
    const response = await PATCH(proposalPatchRequest({ title: "Updated", expectedVersion: 2 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", proposalId: "proposal-1" }),
    });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code, message } });
  });
});
