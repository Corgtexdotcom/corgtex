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
const deleteSource = vi.fn();
const enforceDemoGuard = vi.fn();
const ingestSource = vi.fn();
const publishArticle = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const requireWorkspaceMembership = vi.fn(async () => ({
  id: "member-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  role: "MEMBER",
  isActive: true,
}));
const returnArticleToDraft = vi.fn();
const updateArticle = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  AGREEMENT_BRAIN_ARTICLE_AUTHORITIES: ["AUTHORITATIVE", "REFERENCE"],
  AGREEMENT_BRAIN_ARTICLE_TYPES: ["DECISION", "PROCESS", "CULTURE", "STRATEGY"],
  createArticle,
  deleteSource,
  ingestSource,
  publishArticle,
  requireWorkspaceMembership,
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
  it("archives a Brain source through the existing delete path", async () => {
    const { deleteSourceAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("sourceId", "source-1");

    await deleteSourceAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(deleteSource).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      sourceId: "source-1",
    });
  });

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
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor, workspaceId: "workspace-1" });
    expect(createArticle).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Customer escalation ownership",
      type: "PROCESS",
      authority: "REFERENCE",
      bodyMd: "Support owns first response; product owns root-cause follow-up.",
      isPrivate: false,
      ownerMemberId: "member-1",
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
    expect(createArticle.mock.calls[0]?.[1]).toHaveProperty("ownerMemberId", undefined);
    expect(requireWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("keeps tampered private working agreements as editable drafts", async () => {
    const { createArticleAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("agreementCapture", "working-agreement");
    formData.set("title", "Private escalation note");
    formData.set("type", "PROCESS");
    formData.set("authority", "REFERENCE");
    formData.set("bodyMd", "Draft agreement body.");
    formData.set("isPrivate", "on");

    await createArticleAction(formData);

    expect(createArticle).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      authority: "DRAFT",
      isPrivate: true,
      ownerMemberId: "member-1",
    }));
  });

  it("keeps tampered public working agreements visible in the Agreements list", async () => {
    const { createArticleAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("agreementCapture", "working-agreement");
    formData.set("title", "Visible escalation agreement");
    formData.set("type", "PRODUCT");
    formData.set("authority", "DRAFT");
    formData.set("bodyMd", "Escalations stay visible on the Agreements page.");

    await createArticleAction(formData);

    expect(createArticle).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      type: "PROCESS",
      authority: "REFERENCE",
      isPrivate: false,
      ownerMemberId: "member-1",
    }));
  });
});
