import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  effectiveFlag: vi.fn(),
  reviews: vi.fn(),
  workspace: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor: async () => ({ kind: "user", user: { id: "admin" } }),
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@corgtex/shared", () => ({ prisma: { workspace: { findUnique: mocks.workspace } } }));
vi.mock("@corgtex/domain", () => ({
  isBrainSourceRemovalEnabled: mocks.effectiveFlag,
  requireWorkspaceMembership: async () => ({ id: "member", role: "ADMIN" }),
  listSources: async () => ({ items: [{ id: "source", title: "Synthetic source", sourceType: "DOC", tier: 1,
    absorbedAt: null, channel: null, authorMember: null, authorMemberId: null, fileStorageKey: null,
    createdAt: new Date("2026-01-01T00:00:00Z"), content: "Synthetic content" }] }),
  listBrainSourceArchiveImpacts: async () => [{ sourceId: "source", blocked: true,
    visibleArticles: [{ id: "article", slug: "article", title: "Synthetic article", kind: "derived" }],
    hasHiddenArticles: false }],
  listBrainSourceRemovalReviews: mocks.reviews,
}));
vi.mock("../actions", () => ({
  deleteSourceAction: async () => {}, ingestSourceAction: async () => {},
  resolveSourceRemovalAction: async () => {}, retrySourceRemovalAction: async () => {},
}));
vi.mock("../../add/DuplicateGuardForm", () => ({
  DuplicateGuardForm: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("./BrainSourceFileUploadForm", () => ({ BrainSourceFileUploadForm: () => null }));

import BrainSourcesPage from "./page";

async function render() {
  return renderToStaticMarkup(await BrainSourcesPage({
    params: Promise.resolve({ workspaceId: "workspace" }), searchParams: Promise.resolve({}),
  }));
}

describe("Brain source removal controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("React", React);
    mocks.workspace.mockResolvedValue({ slug: "synthetic" });
    mocks.reviews.mockResolvedValue([{ sourceId: "source", jobId: "job", status: "COMPLETED", phase: "READY",
      articles: [{ id: "article", title: "Synthetic article", action: "regenerate",
        currentBodyMd: "Old", candidateBodyMd: "New" }] }]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows paused state and disables queued acceptance when effective flag is off", async () => {
    mocks.effectiveFlag.mockResolvedValue(false);
    const html = await render();
    expect(mocks.effectiveFlag).toHaveBeenCalledWith(expect.anything(), "workspace");
    expect(html).toContain("sourceRemovalPaused");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>sourceRemovalAccept<\/button>/);
    expect(html).toMatch(/<button[^>]*>sourceRemovalReject<\/button>/);
  });

  it("permits the review control when runtime and workspace flags both allow it", async () => {
    mocks.effectiveFlag.mockResolvedValue(true);
    const html = await render();
    expect(html).not.toContain("sourceRemovalPaused");
    expect(html).toMatch(/<button[^>]*>sourceRemovalAccept<\/button>/);
  });
});
