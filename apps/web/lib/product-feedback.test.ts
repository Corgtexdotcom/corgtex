import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAction, createWorkItemEvidenceLinks, env, prismaMock } = vi.hoisted(() => ({
  createAction: vi.fn(),
  createWorkItemEvidenceLinks: vi.fn(),
  env: {
    PRODUCT_FEEDBACK_TARGET_WORKSPACE_ID: undefined as string | undefined,
    PRODUCT_FEEDBACK_TARGET_WORKSPACE_SLUG: undefined as string | undefined,
  },
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

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  createAction,
  createWorkItemEvidenceLinks,
}));

vi.mock("@corgtex/shared", () => ({
  env,
  prisma: prismaMock,
}));

describe("product feedback helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.PRODUCT_FEEDBACK_TARGET_WORKSPACE_ID = undefined;
    env.PRODUCT_FEEDBACK_TARGET_WORKSPACE_SLUG = undefined;
    prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({ tx: true }));
  });

  it("resolves the default internal Corgtex workspace by slug", async () => {
    prismaMock.workspace.findUnique.mockResolvedValueOnce({ id: "target-1", slug: "corgtex", name: "Corgtex" });
    const { getProductFeedbackTargetWorkspace } = await import("./product-feedback");

    await expect(getProductFeedbackTargetWorkspace()).resolves.toEqual({ id: "target-1", slug: "corgtex", name: "Corgtex" });

    expect(prismaMock.workspace.findUnique).toHaveBeenCalledWith({
      where: { slug: "corgtex" },
      select: { id: true, slug: true, name: true },
    });
  });

  it("prefers an explicit target workspace ID over the slug", async () => {
    env.PRODUCT_FEEDBACK_TARGET_WORKSPACE_ID = "target-id";
    env.PRODUCT_FEEDBACK_TARGET_WORKSPACE_SLUG = "ignored-slug";
    prismaMock.workspace.findUnique.mockResolvedValueOnce({ id: "target-id", slug: "internal", name: "Internal" });
    const { getProductFeedbackTargetWorkspace } = await import("./product-feedback");

    await getProductFeedbackTargetWorkspace();

    expect(prismaMock.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: "target-id" },
      select: { id: true, slug: true, name: true },
    });
  });

  it("validates screenshot count, type, and size", async () => {
    const { validateProductFeedbackScreenshots } = await import("./product-feedback");

    expect(() => validateProductFeedbackScreenshots([{ name: "ok.png", type: "image/png", size: 1024 }])).not.toThrow();
    expect(() => validateProductFeedbackScreenshots([{ name: "bad.gif", type: "image/gif", size: 1024 }])).toThrow("Screenshots must be PNG, JPEG, or WebP images.");
    expect(() => validateProductFeedbackScreenshots(Array.from({ length: 6 }, (_, index) => ({
      name: `${index}.png`,
      type: "image/png",
      size: 1024,
    })))).toThrow("Too many screenshots attached.");
    expect(() => validateProductFeedbackScreenshots([{ name: "large.png", type: "image/png", size: 11 * 1024 * 1024 }])).toThrow("A screenshot is too large.");
    expect(() => validateProductFeedbackScreenshots(Array.from({ length: 3 }, (_, index) => ({
      name: `${index}.png`,
      type: "image/png",
      size: 9 * 1024 * 1024,
    })))).toThrow("Screenshot attachments are too large.");
  });

  it("builds a private draft internal action payload", async () => {
    createAction.mockResolvedValueOnce({ id: "action-1" });
    const { buildProductFeedbackActionBody, createProductFeedbackAction } = await import("./product-feedback");
    const bodyMd = buildProductFeedbackActionBody({
      message: "The action page needs clearer filtering.",
      screenshotCount: 2,
      context: {
        sourceWorkspaceId: "source-1",
        sourceWorkspaceName: "Acme",
        sourceWorkspaceSlug: "acme",
        submitterEmail: "user@example.com",
        submitterName: "User",
        submitterUserId: "user-1",
        submittedAt: new Date("2026-06-23T12:00:00.000Z"),
        pagePath: "/workspaces/source-1/actions",
        pageTitle: "Actions",
        pageUrl: "https://app.corgtex.com/workspaces/source-1/actions",
        viewportJson: JSON.stringify({ width: 1200, height: 800 }),
      },
    });

    await createProductFeedbackAction({
      targetWorkspace: { id: "target-1", slug: "corgtex", name: "Corgtex" },
      message: "The action page needs clearer filtering.",
      bodyMd,
    });

    expect(bodyMd).toContain("## Feedback");
    expect(bodyMd).toContain("Source workspace: Acme (acme)");
    expect(bodyMd).toContain('"width": 1200');
    expect(createAction).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent",
      workspaceIds: ["target-1"],
    }), expect.objectContaining({
      workspaceId: "target-1",
      title: "Product feedback: The action page needs clearer filtering.",
      priority: 1,
      isPrivate: true,
    }));
  });

  it("links uploaded screenshots as feedback context evidence", async () => {
    createWorkItemEvidenceLinks.mockResolvedValueOnce(["doc-1"]);
    const { linkProductFeedbackEvidence } = await import("./product-feedback");

    await expect(linkProductFeedbackEvidence({
      targetWorkspaceId: "target-1",
      actionId: "action-1",
      documentIds: ["doc-1"],
    })).resolves.toEqual(["doc-1"]);

    expect(createWorkItemEvidenceLinks).toHaveBeenCalledWith({ tx: true }, {
      workspaceId: "target-1",
      entityType: "Action",
      entityId: "action-1",
      documentIds: ["doc-1"],
      purpose: "feedback_context",
    });
  });
});
