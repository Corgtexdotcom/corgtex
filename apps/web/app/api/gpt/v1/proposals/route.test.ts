import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createProposalMock,
  createProposalFromTensionMock,
  getWorkspacePermanentPathForEntityMock,
  loadProposalWorkItemResponseMock,
  requireGptAuthMock,
  serializeProposalWorkItemMock,
  workItemPriorityFromBodyMock,
} = vi.hoisted(() => ({
  createProposalMock: vi.fn(),
  createProposalFromTensionMock: vi.fn(),
  getWorkspacePermanentPathForEntityMock: vi.fn(),
  loadProposalWorkItemResponseMock: vi.fn(),
  requireGptAuthMock: vi.fn(),
  serializeProposalWorkItemMock: vi.fn(),
  workItemPriorityFromBodyMock: vi.fn(),
}));

vi.mock("@/lib/gpt-auth", () => ({
  requireGptAuth: requireGptAuthMock,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError: (error: unknown) => {
    throw error;
  },
}));

vi.mock("@/lib/work-item-api", () => ({
  loadProposalWorkItemResponse: loadProposalWorkItemResponseMock,
  serializeProposalWorkItem: serializeProposalWorkItemMock,
  workItemPriorityFromBody: workItemPriorityFromBodyMock,
}));

vi.mock("@corgtex/domain", () => ({
  createProposal: createProposalMock,
  createProposalFromTension: createProposalFromTensionMock,
  getWorkspacePermanentPathForEntity: getWorkspacePermanentPathForEntityMock,
  listProposals: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    APP_URL: "https://app.corgtex.com",
  },
}));

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.test",
    displayName: "User",
  },
};

describe("POST /api/gpt/v1/proposals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireGptAuthMock.mockResolvedValue({
      workspaceId: "workspace-1",
      actor,
      scopes: ["write"],
    });
    getWorkspacePermanentPathForEntityMock.mockResolvedValue(null);
    loadProposalWorkItemResponseMock.mockResolvedValue(null);
    serializeProposalWorkItemMock.mockReturnValue({
      priority: 0,
      priorityLabel: "Low",
      ownerMemberId: null,
      ownerMemberName: null,
      owner: "No owner",
    });
    workItemPriorityFromBodyMock.mockReturnValue(undefined);
  });

  it("rejects malformed explicit ownerMemberId values", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/gpt/v1/proposals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify({
        title: "Clarify owner behavior",
        bodyMd: "Malformed owner should fail.",
        ownerMemberId: 123,
      }),
    }) as never);

    expect(response.status).toBe(400);
    expect(createProposalMock).not.toHaveBeenCalled();
    expect(createProposalFromTensionMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "ownerMemberId must be a string, null, or omitted",
    });
  });

  it("omits ownerMemberId when the GPT body omits the owner", async () => {
    createProposalMock.mockResolvedValueOnce({
      id: "proposal-1",
      title: "Default owner",
      status: "DRAFT",
    });

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/gpt/v1/proposals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify({
        title: "Default owner",
        bodyMd: "No owner field sent.",
      }),
    }) as never);

    expect(response.status).toBe(200);
    expect(createProposalMock.mock.calls[0]?.[1]).not.toHaveProperty("ownerMemberId");
  });

  it("passes explicit null ownerMemberId through to proposal creation", async () => {
    createProposalMock.mockResolvedValueOnce({
      id: "proposal-2",
      title: "Ownerless",
      status: "DRAFT",
    });

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/gpt/v1/proposals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify({
        title: "Ownerless",
        bodyMd: "Explicitly no owner.",
        ownerMemberId: null,
      }),
    }) as never);

    expect(response.status).toBe(200);
    expect(createProposalMock).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      ownerMemberId: null,
    }));
  });
});
