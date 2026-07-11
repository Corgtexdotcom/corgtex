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

const assignAgentToCircle = vi.fn();
const assignRole = vi.fn();
const createCircle = vi.fn();
const createRole = vi.fn();
const deleteCircle = vi.fn();
const deleteRole = vi.fn();
const enforceDemoGuard = vi.fn();
const reassignRole = vi.fn();
const removeAgentFromCircle = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const unassignRole = vi.fn();
const updateCircle = vi.fn();
const updateRole = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  assignAgentToCircle,
  assignRole,
  createCircle,
  createRole,
  deleteCircle,
  deleteRole,
  reassignRole,
  removeAgentFromCircle,
  unassignRole,
  updateCircle,
  updateRole,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("circle server actions", () => {
  it("reassigns a role holder through the domain reassignment primitive", async () => {
    const { reassignRoleAction } = await import("./actions");
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("roleId", "role-1");
    formData.set("fromMemberId", "member-1");
    formData.set("toMemberId", "member-2");

    await reassignRoleAction(formData);

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(reassignRole).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      fromMemberId: "member-1",
      toMemberId: "member-2",
      expiresAt: null,
      transferReason: null,
    });
  });
});
