import React from "react";
import { Writable } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  knowledge: vi.fn(), chunks: vi.fn(), membership: vi.fn(), plan: vi.fn(), onboarding: vi.fn(), workspaces: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requirePageActor: async () => ({ kind: "user", user: { id: "member" } }),
  logoutAction: async () => {},
}));
vi.mock("@corgtex/domain", () => ({
  listActorWorkspaces: f.workspaces, requireWorkspaceMembership: f.membership,
  getWorkspaceInitialKnowledgeSummary: f.knowledge, getUserWorkspaceOnboardingState: f.onboarding,
  getUnreadNotificationSummary: async () => ({ count: 0, complete: true }),
  listRecentConversations: async () => ({ items: [], complete: true }),
  listDailyCompanyUnderstandingQuestions: async () => [], getMemberInvitePolicy: async () => null,
  resolveWorkspaceModuleAccess: async () => ({}), getWorkspaceMcpInstallUrl: () => "/mcp",
  getAiWorkspaceSelectionState: async () => ({ activeProviderKey: null, connections: [], providers: [] }),
  isGlobalOperator: () => false, hasActiveWorkspaceSupport: async () => false,
  SELF_SERVE_WORKSPACE_TOUR_KEY: "tour", SELF_SERVE_WORKSPACE_TOUR_VERSION: "v1",
}));
vi.mock("@corgtex/shared", () => ({
  prisma: { workspace: { findUnique: f.plan }, oAuthConnection: { findFirst: async () => null } },
  workspaceBranding: () => ({}),
}));
vi.mock("@corgtex/knowledge", () => ({ getReadableKnowledgeChunkSummary: f.chunks }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/workspace-feature-flags", () => ({
  getWorkspaceFeatureFlags: async () => ({}), filterNavGroupsByWorkspaceAccess: () => [],
}));
vi.mock("@/lib/deployment-workspace-scope", () => ({ filterWorkspacesForDeploymentScope: (rows: unknown) => rows }));
vi.mock("@/lib/control-plane-url", () => ({ getControlPlaneHref: () => "/control-plane" }));
vi.mock("@/lib/product-feedback", () => ({ getProductFeedbackTargetWorkspace: async () => null }));
vi.mock("./LanguageSwitcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("./ProductFeedbackWidget", () => ({ ProductFeedbackWidget: () => null }));
vi.mock("./MobileWorkspaceShell", () => ({ MobileWorkspaceShell: () => null }));
vi.mock("./WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("./DesktopWorkspaceNav", () => ({ DesktopWorkspaceNav: () => null }));
vi.mock("../../../ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("./WorkspaceIntercomMessenger", () => ({ WorkspaceIntercomMessenger: () => null }));
vi.mock("./WorkspaceNavIcon", () => ({ WorkspaceNavIcon: () => null, WorkspaceUtilityIcon: () => null }));
vi.mock("./WorkspaceAddMenu", () => ({ WorkspaceAddMenu: () => null }));
vi.mock("./WorkspaceChatRail", () => ({ WorkspaceChatRail: () => null }));
vi.mock("./DemoTour", () => ({ DemoTour: () => null }));
vi.mock("./DemoBanner", () => ({ DemoBanner: () => null }));
vi.mock("./WorkspaceOnboardingTour", () => ({
  WorkspaceOnboardingTour: ({ hasInitialKnowledge }: { hasInitialKnowledge: boolean }) =>
    React.createElement("span", {}, hasInitialKnowledge ? "existing content" : "initial setup"),
}));
import WorkspaceLayout from "./layout";

vi.stubGlobal("React", React);
const layout = () => WorkspaceLayout({ params: Promise.resolve({ workspaceId: "ws", locale: "en" }), children: "Workspace content" });

beforeEach(() => {
  vi.resetAllMocks();
  f.membership.mockResolvedValue({ role: "ADMIN", id: "member" });
  f.workspaces.mockResolvedValue([{ id: "ws", name: "Example", slug: "example" }]);
  f.plan.mockResolvedValue({ plan: "SELF_SERVE" });
  f.onboarding.mockResolvedValue({ completedAt: null });
});

it("streams the authenticated shell while the tour waits for its knowledge result", async () => {
  let resolveKnowledge!: (value: { found: boolean; complete: boolean }) => void;
  f.knowledge.mockReturnValue(new Promise(resolve => { resolveKnowledge = resolve; }));
  const tree = await layout();
  let output = "";
  let firstChunk!: () => void;
  const started = new Promise<void>(resolve => { firstChunk = resolve; });
  const writable = new Writable({
    write(chunk, _encoding, done) { output += chunk.toString(); firstChunk(); done(); },
  });
  const finished = new Promise<void>((resolve, reject) => {
    writable.on("finish", resolve);
    writable.on("error", reject);
  });
  const stream = renderToPipeableStream(tree, { onShellReady() { stream.pipe(writable); } });
  try {
    await started;
    expect(output).toContain("Workspace content");
    expect(output).not.toMatch(/existing content|initial setup/);
    expect(f.knowledge).toHaveBeenCalledExactlyOnceWith({ kind: "user", user: { id: "member" } }, "ws");
    resolveKnowledge({ found: true, complete: true });
    await finished;
    expect(output).toContain("existing content");
    expect(f.chunks).not.toHaveBeenCalled();
  } finally {
    stream.abort();
  }
}, 3000);

it.each(["demo", "enterprise", "no onboarding state"])("skips the optional knowledge check for %s", async mode => {
  if (mode === "demo") f.workspaces.mockResolvedValue([{ id: "ws", name: "Example", slug: "jnj-demo" }]);
  if (mode === "enterprise") f.plan.mockResolvedValue({ plan: "ENTERPRISE_MANAGED" });
  if (mode === "no onboarding state") f.onboarding.mockResolvedValue(null);
  await layout();
  expect(f.knowledge).not.toHaveBeenCalled();
  expect(f.chunks).not.toHaveBeenCalled();
});

it("fails the layout on denied membership before starting optional tour work", async () => {
  f.membership.mockRejectedValue(new Error("Access denied"));
  await expect(layout()).rejects.toThrow("Access denied");
  expect(f.knowledge).not.toHaveBeenCalled();
});
