import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  actor,
  AppError,
  checkApiDemoGuard,
  listWorkspaceExternalResources,
  requireWorkspaceMembership,
  resolveRequestActor,
  upsertWorkspaceExternalResourceFromUrl,
} = vi.hoisted(() => {
  class MockAppError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "AppError";
    }
  }

  return {
    actor: {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
        globalRole: "USER",
      },
    },
    AppError: MockAppError,
    checkApiDemoGuard: vi.fn(),
    listWorkspaceExternalResources: vi.fn(),
    requireWorkspaceMembership: vi.fn(),
    resolveRequestActor: vi.fn(),
    upsertWorkspaceExternalResourceFromUrl: vi.fn(),
  };
});

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/demo-guard", () => ({
  checkApiDemoGuard,
}));

vi.mock("@corgtex/domain", () => ({
  AppError,
  listWorkspaceExternalResources,
  requireWorkspaceMembership,
  upsertWorkspaceExternalResourceFromUrl,
  WORKSPACE_EXTERNAL_RESOURCE_ENTITY_TYPES: ["Action", "Tension", "Proposal", "Meeting", "BrainSource"],
  WORKSPACE_EXTERNAL_RESOURCE_PURPOSES: ["reference", "completion_evidence", "resolution_evidence", "feedback_context"],
}));

vi.mock("@corgtex/shared", () => ({
  isDatabaseUnavailableError: vi.fn(() => false),
}));

vi.mock("@corgtex/shared/telemetry", () => ({
  captureErrorTelemetry: vi.fn(),
}));

function workspaceContext(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function jsonRequest(path: string, body: unknown, method = "POST") {
  return new NextRequest(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveRequestActor.mockResolvedValue(actor);
  requireWorkspaceMembership.mockResolvedValue({ id: "membership-1", role: "ADMIN" });
  checkApiDemoGuard.mockResolvedValue(undefined);
  listWorkspaceExternalResources.mockResolvedValue([]);
  upsertWorkspaceExternalResourceFromUrl.mockResolvedValue({ id: "resource-1", url: "https://example.com" });
});

describe("POST /api/workspaces/[workspaceId]/external-resources", () => {
  it("saves a reference link after passing the demo guard", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/external-resources", {
        url: "https://example.com/reference",
        descriptionMd: "Reference",
        entityType: "Proposal",
        entityId: "proposal-1",
        purpose: "reference",
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(201);
    expect(checkApiDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(checkApiDemoGuard.mock.invocationCallOrder[0]).toBeLessThan(
      upsertWorkspaceExternalResourceFromUrl.mock.invocationCallOrder[0],
    );
    expect(upsertWorkspaceExternalResourceFromUrl).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      url: "https://example.com/reference",
      descriptionMd: "Reference",
      summaryMd: undefined,
      entityType: "Proposal",
      entityId: "proposal-1",
      purpose: "reference",
    });
  });

  it("rejects demo workspace writes before saving a reference link", async () => {
    checkApiDemoGuard.mockRejectedValueOnce(
      new AppError(403, "DEMO_MODE", "This is a read-only demo environment. Modifications are disabled."),
    );
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/external-resources", {
        url: "https://example.com/reference",
        entityType: "Proposal",
        entityId: "proposal-1",
        purpose: "reference",
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(403);
    expect(upsertWorkspaceExternalResourceFromUrl).not.toHaveBeenCalled();
  });
});
