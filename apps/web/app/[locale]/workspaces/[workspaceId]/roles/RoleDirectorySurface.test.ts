import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getLocale, getTranslations } from "next-intl/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";
import { RoleDirectorySurface } from "./RoleDirectorySurface";

vi.mock("next-intl/server", () => ({ getLocale: vi.fn(), getTranslations: vi.fn() }));
vi.mock("@/lib/components/ui/ActionMenu", () => ({
  ActionMenu: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../circles/actions", () => ({
  assignRoleAction: vi.fn(),
  deleteRoleAction: vi.fn(),
  reassignRoleAction: vi.fn(),
  unassignRoleAction: vi.fn(),
  updateRoleAction: vi.fn(),
}));

const role = {
  id: "role-1",
  name: "Operations lead",
  purposeMd: "Coordinate work",
  accountabilities: [],
  artifacts: [],
  coreRoleType: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  circle: { id: "circle-1", name: "Operations" },
  assignments: [],
};

function translation(messages: typeof enMessages | typeof esMessages, namespace: string, key: string) {
  const entries = (messages as unknown as Record<string, Record<string, unknown>>)[namespace];
  const value = entries?.[key];
  return typeof value === "string" ? value : key;
}

async function renderRoleDirectory(canManageStructure: boolean, baseHref = "/workspaces/workspace-1/roles") {
  const surface = await RoleDirectorySurface({
    workspaceId: "workspace-1",
    baseHref,
    roles: [role],
    circles: [role.circle],
    members: [],
    onboardingByRoleMember: new Map(),
    canManageStructure,
    showToolbar: false,
    showFilters: false,
  });
  return renderToStaticMarkup(surface);
}

describe("Role directory edit guidance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("React", React);
    vi.mocked(getLocale).mockResolvedValue("en");
  });

  it.each([
    ["en", enMessages, "Only workspace facilitators and admins can edit role descriptions."],
    ["es", esMessages, "Solo los facilitadores y administradores del espacio de trabajo pueden editar las descripciones de los roles."],
  ] as const)("explains the read-only role view in %s without exposing edit controls", async (_locale, messages, expected) => {
    vi.mocked(getTranslations).mockImplementation(async (namespace) => (
      (key: string) => translation(messages, String(namespace), key)
    ) as never);

    const markup = await renderRoleDirectory(false);
    expect(markup).toContain('role="note"');
    expect(markup).toContain(expected);
    expect(markup).not.toContain('name="purposeMd"');
    expect(markup).not.toContain(messages.roles.actionEdit);
  });

  it("shows the description edit control to an authorized editor without read-only guidance", async () => {
    vi.mocked(getTranslations).mockImplementation(async (namespace) => (
      (key: string) => translation(enMessages, String(namespace), key)
    ) as never);

    const markup = await renderRoleDirectory(true);
    expect(markup).toContain('name="purposeMd"');
    expect(markup).toContain(enMessages.roles.actionEdit);
    expect(markup).not.toContain(enMessages.roles.readOnlyEditHelp);
  });

  it.each([
    ["list", "/workspaces/workspace-1/roles"],
    ["detail", "/workspaces/workspace-1/roles/role-1"],
  ])("keeps the confirmation form wired from the %s view", async (_view, baseHref) => {
    vi.mocked(getTranslations).mockImplementation(async (namespace) => (
      (key: string) => translation(enMessages, String(namespace), key)
    ) as never);

    const markup = await renderRoleDirectory(true, baseHref);
    expect(markup).toContain('name="roleId" value="role-1"');
    expect(markup).toContain('name="locale" value="en"');
    expect(markup).toContain('<button type="submit" class="danger" disabled="">Archive</button>');
  });
});
