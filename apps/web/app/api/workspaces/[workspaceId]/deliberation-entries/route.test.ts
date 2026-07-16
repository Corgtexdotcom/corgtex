import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  actor,
  AppError,
  checkApiDemoGuard,
  getAction,
  getProposal,
  getTension,
  postDeliberationEntry,
  requireWorkspaceMembership,
  resolveDeliberationEntry,
  resolveRequestActor,
  updateDeliberationEntry,
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
    getAction: vi.fn(),
    getProposal: vi.fn(),
    getTension: vi.fn(),
    postDeliberationEntry: vi.fn(),
    requireWorkspaceMembership: vi.fn(),
    resolveDeliberationEntry: vi.fn(),
    resolveRequestActor: vi.fn(),
    updateDeliberationEntry: vi.fn(),
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
  getAction,
  getProposal,
  getTension,
  postDeliberationEntry,
  requireWorkspaceMembership,
  resolveDeliberationEntry,
  updateDeliberationEntry,
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

function entryContext(workspaceId = "workspace-1", entryId = "entry-1") {
  return { params: Promise.resolve({ workspaceId, entryId }) };
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
  getAction.mockResolvedValue({ id: "action-1", archivedAt: null });
  getProposal.mockResolvedValue({ id: "proposal-1", archivedAt: null });
  getTension.mockResolvedValue({ id: "tension-1", archivedAt: null });
  postDeliberationEntry.mockResolvedValue({ id: "entry-1", bodyMd: "Looks good." });
  updateDeliberationEntry.mockResolvedValue({ id: "entry-1", bodyMd: "Updated." });
  resolveDeliberationEntry.mockResolvedValue({ id: "entry-1", resolvedNote: "Handled." });
});

describe("POST /api/workspaces/[workspaceId]/deliberation-entries", () => {
  it("creates a deliberation entry through the domain service", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries", {
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        entryType: "REACTION",
        bodyMd: "Looks good.",
        targetMemberId: "member-1",
        adviceRequestId: "request-1",
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(201);
    expect(checkApiDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(getProposal).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
    });
    expect(checkApiDemoGuard.mock.invocationCallOrder[0]).toBeLessThan(
      postDeliberationEntry.mock.invocationCallOrder[0],
    );
    expect(getProposal.mock.invocationCallOrder[0]).toBeLessThan(
      postDeliberationEntry.mock.invocationCallOrder[0],
    );
    expect(postDeliberationEntry).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      parentType: "PROPOSAL",
      parentId: "proposal-1",
      entryType: "REACTION",
      bodyMd: "Looks good.",
      targetMemberId: "member-1",
      targetCircleId: undefined,
      adviceRequestId: "request-1",
    });
    await expect(response.json()).resolves.toEqual({
      entry: { id: "entry-1", bodyMd: "Looks good." },
    });
  });

  it("returns validation errors before calling the domain service", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries", {
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        entryType: "REACTION",
        bodyMd: "",
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(400);
    expect(postDeliberationEntry).not.toHaveBeenCalled();
  });

  it("rejects demo workspace writes before creating a deliberation entry", async () => {
    checkApiDemoGuard.mockRejectedValueOnce(
      new AppError(403, "DEMO_MODE", "This is a read-only demo environment. Modifications are disabled."),
    );
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries", {
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        entryType: "REACTION",
        bodyMd: "Looks good.",
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(403);
    expect(getProposal).not.toHaveBeenCalled();
    expect(postDeliberationEntry).not.toHaveBeenCalled();
  });

  it("rejects unreadable proposal parents before creating a deliberation entry", async () => {
    getProposal.mockRejectedValueOnce(new AppError(404, "NOT_FOUND", "Proposal not found."));
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries", {
        parentType: "PROPOSAL",
        parentId: "proposal-private",
        entryType: "REACTION",
        bodyMd: "Looks good.",
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(404);
    expect(postDeliberationEntry).not.toHaveBeenCalled();
  });

  it("checks action parent visibility before creating a deliberation entry", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries", {
        parentType: "action",
        parentId: "action-1",
        entryType: "REACTION",
        bodyMd: "Looks good.",
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(201);
    expect(getAction).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
    });
    expect(postDeliberationEntry).toHaveBeenCalledWith(actor, expect.objectContaining({
      parentType: "ACTION",
      parentId: "action-1",
    }));
  });

  it("rejects archived tension parents before creating a deliberation entry", async () => {
    getTension.mockResolvedValueOnce({ id: "tension-1", archivedAt: new Date("2026-01-01T00:00:00.000Z") });
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries", {
        parentType: "TENSION",
        parentId: "tension-1",
        entryType: "REACTION",
        bodyMd: "Looks good.",
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(404);
    expect(postDeliberationEntry).not.toHaveBeenCalled();
  });

  it("returns unauthenticated errors from the route wrapper", async () => {
    resolveRequestActor.mockRejectedValueOnce(new AppError(401, "UNAUTHENTICATED", "Missing session."));
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries", {
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        entryType: "REACTION",
        bodyMd: "Looks good.",
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(401);
    expect(postDeliberationEntry).not.toHaveBeenCalled();
  });

  it("blocks actors without workspace membership", async () => {
    requireWorkspaceMembership.mockRejectedValueOnce(new AppError(403, "FORBIDDEN", "Workspace membership required."));
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries", {
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        entryType: "REACTION",
        bodyMd: "Looks good.",
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(403);
    expect(postDeliberationEntry).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/workspaces/[workspaceId]/deliberation-entries/[entryId]", () => {
  it("updates the requested deliberation entry", async () => {
    const { PATCH } = await import("./[entryId]/route");

    const response = await PATCH(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries/entry-1", {
        entryType: "OBJECTION",
        bodyMd: "This needs a constraint.",
      }, "PATCH"),
      entryContext(),
    );

    expect(response.status).toBe(200);
    expect(checkApiDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(updateDeliberationEntry).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      entryId: "entry-1",
      entryType: "OBJECTION",
      bodyMd: "This needs a constraint.",
    });
  });

  it("returns validation errors before editing a deliberation entry", async () => {
    const { PATCH } = await import("./[entryId]/route");

    const response = await PATCH(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries/entry-1", {}, "PATCH"),
      entryContext(),
    );

    expect(response.status).toBe(400);
    expect(updateDeliberationEntry).not.toHaveBeenCalled();
  });

  it("rejects demo workspace writes before editing a deliberation entry", async () => {
    checkApiDemoGuard.mockRejectedValueOnce(
      new AppError(403, "DEMO_MODE", "This is a read-only demo environment. Modifications are disabled."),
    );
    const { PATCH } = await import("./[entryId]/route");

    const response = await PATCH(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries/entry-1", {
        bodyMd: "Edited.",
      }, "PATCH"),
      entryContext(),
    );

    expect(response.status).toBe(403);
    expect(updateDeliberationEntry).not.toHaveBeenCalled();
  });

  it("blocks entry updates for actors without workspace membership", async () => {
    requireWorkspaceMembership.mockRejectedValueOnce(new AppError(403, "FORBIDDEN", "Workspace membership required."));
    const { PATCH } = await import("./[entryId]/route");

    const response = await PATCH(
      jsonRequest("http://localhost/api/workspaces/workspace-2/deliberation-entries/entry-1", {
        bodyMd: "Edited.",
      }, "PATCH"),
      entryContext("workspace-2"),
    );

    expect(response.status).toBe(403);
    expect(updateDeliberationEntry).not.toHaveBeenCalled();
  });

  it("surfaces resolved-entry edit rejection", async () => {
    updateDeliberationEntry.mockRejectedValueOnce(
      new AppError(400, "INVALID_STATE", "Resolved deliberation entries cannot be edited."),
    );
    const { PATCH } = await import("./[entryId]/route");

    const response = await PATCH(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries/entry-1", {
        bodyMd: "Edited.",
      }, "PATCH"),
      entryContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_STATE" },
    });
  });
});

describe("POST /api/workspaces/[workspaceId]/deliberation-entries/[entryId]/resolve", () => {
  it("resolves the requested deliberation entry", async () => {
    const { POST } = await import("./[entryId]/resolve/route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries/entry-1/resolve", {
        resolvedNote: "Handled.",
      }),
      entryContext(),
    );

    expect(response.status).toBe(200);
    expect(checkApiDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(resolveDeliberationEntry).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      entryId: "entry-1",
      resolvedNote: "Handled.",
    });
  });

  it("returns validation errors before resolving a deliberation entry", async () => {
    const { POST } = await import("./[entryId]/resolve/route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries/entry-1/resolve", {
        resolvedNote: "",
      }),
      entryContext(),
    );

    expect(response.status).toBe(400);
    expect(resolveDeliberationEntry).not.toHaveBeenCalled();
  });

  it("rejects demo workspace writes before resolving a deliberation entry", async () => {
    checkApiDemoGuard.mockRejectedValueOnce(
      new AppError(403, "DEMO_MODE", "This is a read-only demo environment. Modifications are disabled."),
    );
    const { POST } = await import("./[entryId]/resolve/route");

    const response = await POST(
      jsonRequest("http://localhost/api/workspaces/workspace-1/deliberation-entries/entry-1/resolve", {
        resolvedNote: "Handled.",
      }),
      entryContext(),
    );

    expect(response.status).toBe(403);
    expect(resolveDeliberationEntry).not.toHaveBeenCalled();
  });
});
