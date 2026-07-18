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

const createArticle = vi.fn();
const enforceDemoGuard = vi.fn();
const ingestSource = vi.fn();
const publishArticle = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const returnArticleToDraft = vi.fn();
const updateArticle = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  createArticle,
  ingestSource,
  publishArticle,
  returnArticleToDraft,
  updateArticle,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Brain article server actions", () => {
  it("captures manual working agreement source and context as article frontmatter", async () => {
    const { createArticleAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("agreementCapture", "working-agreement");
    formData.set("title", "Customer escalation ownership");
    formData.set("type", "PROCESS");
    formData.set("authority", "REFERENCE");
    formData.set("bodyMd", "Support owns first response; product owns root-cause follow-up.");
    formData.set("agreementSource", "July 17 operations review");
    formData.set("agreementContext", "Captured during the weekly operations review after the handoff delay.");

    await createArticleAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(createArticle).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Customer escalation ownership",
      type: "PROCESS",
      authority: "REFERENCE",
      bodyMd: "Support owns first response; product owns root-cause follow-up.",
      isPrivate: false,
      frontmatterJson: {
        workingAgreement: {
          source: "July 17 operations review",
          context: "Captured during the weekly operations review after the handoff delay.",
        },
      },
    }));
  });

  it("does not add working agreement frontmatter for normal Brain articles", async () => {
    const { createArticleAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("title", "Deployment glossary");
    formData.set("type", "GLOSSARY");
    formData.set("authority", "DRAFT");
    formData.set("bodyMd", "Release ring means a deployment cohort.");
    formData.set("agreementSource", "Should not be used without the capture marker");
    formData.set("isPrivate", "on");

    await createArticleAction(formData);

    expect(createArticle).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Deployment glossary",
      type: "GLOSSARY",
      authority: "DRAFT",
      isPrivate: true,
    }));
    expect(createArticle.mock.calls[0]?.[1]).toHaveProperty("frontmatterJson", undefined);
  });
});
