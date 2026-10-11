import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteRole: vi.fn(),
  enforceDemoGuard: vi.fn(),
  redirect: vi.fn(),
  refresh: vi.fn(),
  requirePageActor: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  assignAgentToCircle: vi.fn(),
  assignRole: vi.fn(),
  createCircle: vi.fn(),
  createRole: vi.fn(),
  deleteCircle: vi.fn(),
  deleteRole: mocks.deleteRole,
  removeAgentFromCircle: vi.fn(),
  reassignRole: vi.fn(),
  unassignRole: vi.fn(),
  updateCircle: vi.fn(),
  updateRole: vi.fn(),
}));
vi.mock("@/lib/demo-guard", () => ({ enforceDemoGuard: mocks.enforceDemoGuard }));
vi.mock("@/lib/auth", () => ({ requirePageActor: mocks.requirePageActor }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("../action-utils", () => ({
  asString: (formData: FormData, key: string) => String(formData.get(key) ?? ""),
  asOptional: (formData: FormData, key: string) => String(formData.get(key) ?? "").trim() || null,
  refresh: mocks.refresh,
}));

import { deleteRoleAction } from "./actions";

const actor = { kind: "user", user: { id: "user-1" } };

function archiveForm(locale = "en") {
  const formData = new FormData();
  formData.set("workspaceId", "workspace-1");
  formData.set("roleId", "role-1");
  formData.set("locale", locale);
  return formData;
}

describe("Role archive action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePageActor.mockResolvedValue(actor);
  });

  it("returns detail and list archive submissions to the same workspace Roles list after success", async () => {
    await deleteRoleAction(archiveForm());

    expect(mocks.enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(mocks.deleteRole).toHaveBeenCalledWith(actor, { workspaceId: "workspace-1", roleId: "role-1" });
    expect(mocks.refresh).toHaveBeenCalledWith("workspace-1");
    expect(mocks.redirect).toHaveBeenCalledWith("/en/workspaces/workspace-1/roles?archivedRole=role-1");
  });

  it("preserves Spanish locale and normalizes unexpected locale input", async () => {
    await deleteRoleAction(archiveForm("es"));
    expect(mocks.redirect).toHaveBeenLastCalledWith("/es/workspaces/workspace-1/roles?archivedRole=role-1");

    await deleteRoleAction(archiveForm("../other"));
    expect(mocks.redirect).toHaveBeenLastCalledWith("/en/workspaces/workspace-1/roles?archivedRole=role-1");
  });

  it("does not redirect or show success when the domain denies the archive", async () => {
    mocks.deleteRole.mockRejectedValueOnce(new Error("Forbidden"));

    await expect(deleteRoleAction(archiveForm())).rejects.toThrow("Forbidden");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("does not call the domain or redirect when the demo guard rejects the archive", async () => {
    mocks.enforceDemoGuard.mockRejectedValueOnce(new Error("Read only"));

    await expect(deleteRoleAction(archiveForm())).rejects.toThrow("Read only");
    expect(mocks.deleteRole).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
