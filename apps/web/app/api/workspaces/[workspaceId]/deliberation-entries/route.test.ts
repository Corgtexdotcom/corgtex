import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  actor,
  AppError,
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

vi.mock("@corgtex/domain", () => ({
  AppError,
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
});
