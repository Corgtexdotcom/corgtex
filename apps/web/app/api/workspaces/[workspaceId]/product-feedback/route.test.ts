import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  actorState,
  checkApiDemoGuard,
  checkRateLimit,
  createAction,
  createWorkItemEvidenceLinks,
  env,
  ingestFile,
  prismaMock,
} = vi.hoisted(() => ({
  actorState: {
    actor: {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
        globalRole: "USER",
      },
    } as any,
    error: null as Error | null,
  },
  checkApiDemoGuard: vi.fn(),
  checkRateLimit: vi.fn(),
  createAction: vi.fn(),
  createWorkItemEvidenceLinks: vi.fn(),
  env: {
    PRODUCT_FEEDBACK_TARGET_WORKSPACE_ID: undefined as string | undefined,
    PRODUCT_FEEDBACK_TARGET_WORKSPACE_SLUG: undefined as string | undefined,
  },
  ingestFile: vi.fn(),
  prismaMock: {
    $transaction: vi.fn(),
    workspace: {
      findUnique: vi.fn(),
    },
  },
}));

class MockAppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function errorResponse(error: unknown) {
  const status = error instanceof MockAppError ? error.status : 500;
  const code = error instanceof MockAppError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return NextResponse.json({ error: { code, message } }, { status });
}

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  createAction,
  createWorkItemEvidenceLinks,
}));

vi.mock("@corgtex/shared", () => ({
  checkRateLimit,
  env,
  prisma: prismaMock,
  RATE_LIMITS: {
    PRODUCT_FEEDBACK_PER_USER: { windowMs: 60_000, limit: 10, failClosed: true },
  },
}));

vi.mock("@corgtex/knowledge", () => ({
  ingestFile,
}));

vi.mock("@/lib/demo-guard", () => ({
  checkApiDemoGuard,
}));

vi.mock("@/lib/route-handler", () => ({
  withWorkspaceRoute: (handler: any) => async (request: NextRequest, context: { params: Promise<Record<string, string>> }) => {
    const params = await context.params;
    if (actorState.error) {
      return errorResponse(actorState.error);
    }
    try {
      return await handler(request, {
        actor: actorState.actor,
        membership: { id: "member-1", role: "ADMIN", isActive: true },
        workspaceId: params.workspaceId,
        params,
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
}));

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function requestWithForm(formData: FormData) {
  return new NextRequest("http://localhost/api/workspaces/workspace-1/product-feedback", {
    method: "POST",
    body: formData,
  });
}

function baseForm() {
  const formData = new FormData();
  formData.set("message", "The actions page needs clearer filters.");
  formData.set("path", "/workspaces/workspace-1/actions");
  formData.set("url", "https://app.corgtex.com/workspaces/workspace-1/actions");
  formData.set("title", "Actions");
  formData.set("locale", "en");
  formData.set("viewport_json", JSON.stringify({ width: 1200, height: 800, devicePixelRatio: 2 }));
  return formData;
}

describe("POST /api/workspaces/[workspaceId]/product-feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actorState.actor = {
      kind: "user",
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
        globalRole: "USER",
      },
    };
    actorState.error = null;
    env.PRODUCT_FEEDBACK_TARGET_WORKSPACE_ID = undefined;
    env.PRODUCT_FEEDBACK_TARGET_WORKSPACE_SLUG = undefined;
    checkApiDemoGuard.mockResolvedValue(undefined);
    checkRateLimit.mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAtMs: Date.now() + 60_000 });
    prismaMock.workspace.findUnique.mockImplementation(async ({ where }: { where: { id?: string; slug?: string } }) => {
      if (where.id === "workspace-1") {
        return { id: "workspace-1", slug: "acme", name: "Acme" };
      }
      return { id: "target-1", slug: "corgtex", name: "Corgtex" };
    });
    prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({ tx: true }));
    createAction.mockResolvedValue({
      id: "action-1",
      title: "Product feedback: The actions page needs clearer filters.",
    });
    ingestFile.mockResolvedValue({ document: { id: "doc-1" } });
    createWorkItemEvidenceLinks.mockResolvedValue(["doc-1"]);
  });

  it("rejects unauthenticated requests", async () => {
    actorState.error = new MockAppError(401, "UNAUTHENTICATED", "Missing session.");
    const { POST } = await import("./route");

    const response = await POST(requestWithForm(baseForm()), context());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Missing session.",
      },
    });
  });

  it("rejects non-member requests before processing feedback", async () => {
    actorState.error = new MockAppError(403, "NOT_A_MEMBER", "Not a member.");
    const { POST } = await import("./route");

    const response = await POST(requestWithForm(baseForm()), context());

    expect(response.status).toBe(403);
    expect(createAction).not.toHaveBeenCalled();
  });

  it("rejects missing product feedback target configuration", async () => {
    prismaMock.workspace.findUnique.mockResolvedValueOnce(null);
    const { POST } = await import("./route");

    const response = await POST(requestWithForm(baseForm()), context());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PRODUCT_FEEDBACK_TARGET_NOT_CONFIGURED",
        message: "Product feedback target workspace is not configured.",
      },
    });
  });

  it("rejects empty messages", async () => {
    const formData = baseForm();
    formData.set("message", " ");
    const { POST } = await import("./route");

    const response = await POST(requestWithForm(formData), context());

    expect(response.status).toBe(400);
    expect(createAction).not.toHaveBeenCalled();
  });

  it("rejects invalid screenshot types, counts, and sizes", async () => {
    const { POST } = await import("./route");

    const badType = baseForm();
    badType.append("screenshots", new File(["bad"], "bad.gif", { type: "image/gif" }));
    expect((await POST(requestWithForm(badType), context())).status).toBe(400);

    const tooMany = baseForm();
    for (let index = 0; index < 6; index += 1) {
      tooMany.append("screenshots", new File(["ok"], `${index}.png`, { type: "image/png" }));
    }
    expect((await POST(requestWithForm(tooMany), context())).status).toBe(400);

    const tooLarge = baseForm();
    tooLarge.append("screenshots", new File([new Uint8Array(11 * 1024 * 1024)], "large.png", { type: "image/png" }));
    expect((await POST(requestWithForm(tooLarge), context())).status).toBe(413);
  });

  it("creates a private draft internal action and links screenshot evidence", async () => {
    const formData = baseForm();
    formData.append("screenshots", new File(["png"], "screen.png", { type: "image/png" }));
    const { POST } = await import("./route");

    const response = await POST(requestWithForm(formData), context());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      actionId: "action-1",
      actionUrl: "/workspaces/target-1/actions/action-1",
      targetWorkspaceId: "target-1",
      screenshotCount: 1,
    });
    expect(createAction).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent",
      workspaceIds: ["target-1"],
    }), expect.objectContaining({
      workspaceId: "target-1",
      priority: 1,
      isPrivate: true,
      bodyMd: expect.stringContaining("The actions page needs clearer filters."),
    }));
    expect(ingestFile).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent",
      workspaceIds: ["target-1"],
    }), expect.objectContaining({
      workspaceId: "target-1",
      uploadSource: "product-feedback",
      mimeType: "image/png",
    }));
    expect(createWorkItemEvidenceLinks).toHaveBeenCalledWith({ tx: true }, {
      workspaceId: "target-1",
      entityType: "Action",
      entityId: "action-1",
      documentIds: ["doc-1"],
      purpose: "feedback_context",
    });
  });
});
