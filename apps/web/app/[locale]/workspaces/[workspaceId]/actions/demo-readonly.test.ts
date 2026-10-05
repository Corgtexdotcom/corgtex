import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  membership: vi.fn(),
  action: vi.fn(),
  actions: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor: async () => ({ kind: "user", user: { id: "synthetic-user", email: "synthetic@example.test" } }),
}));
vi.mock("@corgtex/shared", () => ({
  prisma: {
    workspace: { findUnique: mocks.workspace },
    workItemEvidence: { findMany: async () => [] },
  },
}));
vi.mock("@corgtex/domain", () => ({
  AppError: class AppError extends Error { code = "UNKNOWN"; },
  requireWorkspaceMembership: mocks.membership,
  getAction: mocks.action,
  listActions: mocks.actions,
  listCircles: async () => [],
  listHumanMembers: async () => [{ id: "synthetic-member", user: { displayName: "Synthetic Member", email: "synthetic@example.test" } }],
  listAdviceRequests: async () => [],
  listActionChecklistItems: async () => [{ id: "synthetic-check", title: "Review synthetic checklist", completedAt: null }],
  listWorkItemVersions: async () => ({ entityType: "Action", entityId: "synthetic-action", currentVersion: 1, versions: [] }),
  listWorkItemEvidence: async () => [],
  listExternalResourceAttachments: async () => [],
  listDeliberationEntries: async () => [],
  getWorkspaceArchiveRecord: async () => null,
}));
vi.mock("@/lib/deliberation-targets", () => ({
  getDeliberationTargets: async () => ({ options: [], defaultValue: "", actorMemberId: "synthetic-member", actorCircleIds: [] }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
  usePathname: () => "/workspaces/synthetic-workspace/actions",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "actions" | "common" | "workItems") => createTranslator({ locale: "en", messages, namespace }),
  getFormatter: async () => ({ dateTime: () => "Jan 1" }),
}));
vi.mock("@/lib/components/MarkdownEditor", () => ({
  MarkdownEditor: ({ name }: { name: string }) => React.createElement("textarea", { name }),
}));
vi.mock("../actions", () => ({
  createActionAction: vi.fn(), updateActionAction: vi.fn(), deleteActionAction: vi.fn(),
  publishActionAction: vi.fn(), returnActionToDraftAction: vi.fn(),
  editActionAction: vi.fn(), attachActionExternalResourceAction: vi.fn(),
  createActionChecklistItemAction: vi.fn(), deleteActionChecklistItemAction: vi.fn(),
  postActionDeliberationAction: vi.fn(), requestActionInputAction: vi.fn(),
  resolveActionDeliberationAction: vi.fn(), updateActionChecklistItemAction: vi.fn(),
  updateActionDeliberationAction: vi.fn(),
}));

import ActionsPage from "./page";
import ActionDetailPage from "./[actionId]/page";
import ActionEditPage from "./[actionId]/edit/page";

const action = {
  id: "synthetic-action",
  workspaceId: "synthetic-workspace",
  title: "Review synthetic action",
  bodyMd: "Synthetic notes only.",
  status: "OPEN",
  isPrivate: false,
  archivedAt: null,
  archiveReason: null,
  authorUserId: "synthetic-user",
  author: { displayName: "Synthetic Member", email: "synthetic@example.test" },
  assigneeMemberId: "synthetic-member",
  assigneeMember: { user: { displayName: "Synthetic Member", email: "synthetic@example.test" } },
  circleId: null,
  circle: null,
  proposal: null,
  version: 1,
  priority: 1,
  dueAt: null,
  completedVia: null,
  checklistItemCount: 1,
  checklistCompletedCount: 0,
  createdAt: new Date("2026-01-01T12:00:00Z"),
};

const params = Promise.resolve({ workspaceId: "synthetic-workspace", actionId: action.id });
function renderIntl(children: React.ReactNode) {
  // The provider's TypeScript signature requires children in props for this node-only render.
  // eslint-disable-next-line react/no-children-prop
  return renderToStaticMarkup(React.createElement(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", children,
  }));
}
const renderList = async (view = "list") => renderIntl(await ActionsPage({ params, searchParams: Promise.resolve({ view, scope: "workspace" }) }));
const renderDetail = async () => renderIntl(await ActionDetailPage({ params }));
const renderEdit = async () => renderIntl(await ActionEditPage({ params }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("React", React);
  mocks.workspace.mockResolvedValue({ slug: "jnj-demo" });
  mocks.membership.mockResolvedValue({ id: "synthetic-member", role: "ADMIN", isActive: true });
  mocks.action.mockResolvedValue(action);
  mocks.actions.mockResolvedValue({ items: [action], total: 1 });
});

afterEach(() => vi.unstubAllGlobals());

describe("Action pages in the read-only demo", () => {
  it.each(["list", "table", "kanban"])("keeps the %s view readable without mutation controls", async (view) => {
    const html = await renderList(view);
    expect(html).toContain(action.title);
    expect(html).toContain(`/actions/${action.id}`);
    expect(html).not.toContain('action="javascript:');
    expect(html).not.toContain('name="priority"');
    expect(html).not.toContain('name="dueAt"');
    expect(html).not.toContain(messages.actions.btnStart);
    expect(html).not.toContain(messages.actions.btnDelete);
  });

  it("shows checklist and references without detail mutation controls", async () => {
    const html = await renderDetail();
    expect(html).toContain(action.title);
    expect(html).toContain("Review synthetic checklist");
    expect(html).not.toContain("<form");
    expect(html).not.toContain(`/actions/${action.id}/edit`);
    expect(html).not.toContain(messages.actions.btnStart);
    expect(html).not.toContain(messages.actions.referenceSourcesHint);
  });

  it("does not expose the edit form through a direct edit URL", async () => {
    const html = await renderEdit();
    expect(html).toContain(messages.actions.editUnavailable);
    expect(html).not.toContain("<form");
  });

  it("keeps ordinary workspace action editing available", async () => {
    mocks.workspace.mockResolvedValue({ slug: "ordinary-workspace" });
    expect(await renderList()).toContain(messages.actions.btnStart);
    const detail = await renderDetail();
    expect(detail).toContain("Review synthetic checklist");
    expect(detail).toContain('name="status"');
    expect(detail).toContain(messages.actions.referenceSourcesHint);
    expect(await renderEdit()).toContain('name="title"');
  });

  it("checks membership before workspace data", async () => {
    mocks.membership.mockRejectedValueOnce(new Error("Not a member"));
    await expect(renderList()).rejects.toThrow("Not a member");
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
});
