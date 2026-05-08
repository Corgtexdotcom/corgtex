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
const listProposals = vi.fn();
const requireWorkspaceMembership = vi.fn();
const resolveRequestActor = vi.fn(async () => actor);

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@corgtex/domain", () => ({
  createProposal,
  createProposalFromTension,
  listProposals,
  requireWorkspaceMembership,
}));

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/workspaces/[workspaceId]/proposals", () => {
  it("creates a proposal from a source tension without requiring title or body input", async () => {
    createProposalFromTension.mockResolvedValue({
      id: "proposal-1",
      title: "Resolve tension",
      status: "DRAFT",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/workspaces/workspace-1/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceTensionId: "tension-1",
          relatedActionIds: ["action-1"],
        }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(createProposalFromTension).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      sourceTensionId: "tension-1",
      relatedActionIds: ["action-1"],
    }));
    expect(createProposal).not.toHaveBeenCalled();
  });
});
