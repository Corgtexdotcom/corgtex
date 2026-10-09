import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";

const mocks = vi.hoisted(() => ({
  findWorkspace: vi.fn(),
  getRole: vi.fn(),
  getWorkspaceArchiveRecord: vi.fn(),
  getTranslations: vi.fn(),
  loadRoleDirectoryData: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  requirePageActor: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  AppError: class AppError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
  getRole: mocks.getRole,
  getWorkspaceArchiveRecord: mocks.getWorkspaceArchiveRecord,
  requireWorkspaceMembership: mocks.requireWorkspaceMembership,
}));
vi.mock("@corgtex/shared", () => ({ prisma: { workspace: { findUnique: mocks.findWorkspace } } }));
vi.mock("@/lib/auth", () => ({ requirePageActor: mocks.requirePageActor }));
vi.mock("next-intl/server", () => ({ getTranslations: mocks.getTranslations }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement("a", { href }, children) }));
vi.mock("./RoleDirectorySurface", () => ({ RoleDirectorySurface: () => React.createElement("div", null, "Active Roles") }));
vi.mock("./role-directory", () => ({ loadRoleDirectoryData: mocks.loadRoleDirectoryData }));

import { AppError } from "@corgtex/domain";
import RolesPage from "./page";
import RoleDetailPage from "./[roleId]/page";

const workspaceId = "workspace-1";
const roleId = "role-1";
const actor = { kind: "user", user: { id: "user-1" } };
const archiveRecord = { id: "archive-1", entityLabel: "Operations lead" };

function useMessages(messages: typeof enMessages | typeof esMessages) {
  mocks.getTranslations.mockImplementation(async () => (key: string) => (
    (messages.roles as Record<string, string>)[key] ?? key
  ));
}

async function renderList(archivedRole = roleId) {
  const page = await RolesPage({
    params: Promise.resolve({ workspaceId }),
    searchParams: Promise.resolve({ archivedRole }),
  });
  return renderToStaticMarkup(page);
}

async function renderDetail() {
  const page = await RoleDetailPage({ params: Promise.resolve({ workspaceId, roleId }) });
  return renderToStaticMarkup(page);
}

describe("Role archive navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("React", React);
    mocks.requirePageActor.mockResolvedValue(actor);
    mocks.requireWorkspaceMembership.mockResolvedValue({ id: "member-1", role: "ADMIN" });
    mocks.findWorkspace.mockResolvedValue({ slug: "test-workspace" });
    mocks.loadRoleDirectoryData.mockResolvedValue({ roles: [], circles: [], members: [], onboardingByRoleMember: new Map() });
    mocks.getWorkspaceArchiveRecord.mockResolvedValue(archiveRecord);
    mocks.getRole.mockRejectedValue(new AppError(404, "NOT_FOUND", "Role not found."));
    useMessages(enMessages);
  });

  it.each([
    ["en", enMessages, "Role archived. It no longer appears in the active structure."],
    ["es", esMessages, "Rol archivado. Ya no aparece en la estructura activa."],
  ] as const)("shows %s confirmation on the list with an Admin archive link", async (_locale, messages, expected) => {
    useMessages(messages);

    const markup = await renderList();

    expect(markup).toContain('role="status"');
    expect(markup).toContain(expected);
    expect(markup).toContain(`/workspaces/${workspaceId}/audit?tab=archive&amp;archiveEntityType=Role`);
    expect(markup).toContain("Active Roles");
    expect(mocks.getWorkspaceArchiveRecord).toHaveBeenCalledWith(actor, { workspaceId, entityType: "Role", entityId: roleId });
  });

  it("shows the confirmation to a Facilitator without linking to the Admin-only archive", async () => {
    mocks.requireWorkspaceMembership.mockResolvedValue({ id: "member-1", role: "FACILITATOR" });

    const markup = await renderList();

    expect(markup).toContain(enMessages.roles.archiveSuccess);
    expect(markup).not.toContain("/audit?");
  });

  it("does not reveal archived Role state to a Contributor or for an unverified ID", async () => {
    mocks.requireWorkspaceMembership.mockResolvedValue({ id: "member-1", role: "CONTRIBUTOR" });
    expect(await renderList()).not.toContain('role="status"');
    expect(mocks.getWorkspaceArchiveRecord).not.toHaveBeenCalled();

    mocks.requireWorkspaceMembership.mockResolvedValue({ id: "member-1", role: "ADMIN" });
    mocks.getWorkspaceArchiveRecord.mockResolvedValue(null);
    expect(await renderList()).not.toContain('role="status"');
  });

  it("shows a safe archived detail view when Back revisits the archived Role", async () => {
    const markup = await renderDetail();

    expect(markup).toContain(enMessages.roles.archivedRoleTitle);
    expect(markup).toContain(`/workspaces/${workspaceId}/roles`);
    expect(markup).toContain(`/workspaces/${workspaceId}/audit?tab=archive&amp;archiveEntityType=Role`);
    expect(mocks.getWorkspaceArchiveRecord).toHaveBeenCalledWith(actor, { workspaceId, entityType: "Role", entityId: roleId });
  });

  it("keeps archived detail hidden from Contributors and unknown Role IDs", async () => {
    mocks.requireWorkspaceMembership.mockResolvedValue({ id: "member-1", role: "CONTRIBUTOR" });
    await expect(renderDetail()).rejects.toThrow("NOT_FOUND");
    expect(mocks.getWorkspaceArchiveRecord).not.toHaveBeenCalled();

    mocks.requireWorkspaceMembership.mockResolvedValue({ id: "member-1", role: "ADMIN" });
    mocks.getWorkspaceArchiveRecord.mockResolvedValue(null);
    await expect(renderDetail()).rejects.toThrow("NOT_FOUND");
  });

  it("checks workspace membership before looking up an archived Role", async () => {
    mocks.requireWorkspaceMembership.mockRejectedValue(new AppError(403, "FORBIDDEN", "Forbidden."));

    await expect(renderDetail()).rejects.toThrow("NOT_FOUND");
    expect(mocks.getRole).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceArchiveRecord).not.toHaveBeenCalled();
  });
});
