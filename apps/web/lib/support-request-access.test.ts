import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { membership, grant } = vi.hoisted(() => ({ membership: vi.fn(), grant: vi.fn() }));
vi.mock("@corgtex/domain", async () => ({
  ...(await import("../../../packages/domain/src/errors")),
  requireWorkspaceMembership: membership,
  getWorkspaceSupportGrant: grant,
}));
import { isWorkspaceAuthorizedProviderRoute, requireSupportRequestAccess, workspaceIdFromPath } from "./support-request-access";

const actor: AppActor = { kind: "user", user: { id: "support", email: "support@example.test", displayName: null, isSupportAccount: true } };
beforeEach(() => {
  vi.resetAllMocks();
  membership.mockRejectedValue(new Error("SUPPORT_CONTENT_RESTRICTED"));
  grant.mockResolvedValue({ isActive: true, role: "SETUP" });
});

describe("support request allowlist", () => {
  it.each(["brain/search", "brain/sources/id/file", "members", "agent-runs", "workflow-jobs", "events", "finance/history-archive", "data-sources/test", "build-artifacts/id/assets/id", "support-access"])("blocks Setup at the API boundary for %s", async (suffix) => {
    await expect(requireSupportRequestAccess(actor, `/api/workspaces/ws-1/${suffix}`)).rejects.toThrow("SUPPORT_CONTENT_RESTRICTED");
    expect(membership).toHaveBeenCalledWith({ actor, workspaceId: "ws-1" });
  });
  it("allows only the exact sanitized setup endpoint with a current grant", async () => {
    await expect(requireSupportRequestAccess(actor, "/api/workspaces/ws-1/support-setup")).resolves.toBeUndefined();
    expect(membership).not.toHaveBeenCalled();
    await expect(requireSupportRequestAccess(actor, "/api/workspaces/ws-1/support-setup/export")).rejects.toThrow();
    grant.mockResolvedValue({ isActive: false });
    await expect(requireSupportRequestAccess(actor, "/api/workspaces/ws-1/support-setup")).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
  });
  it.each(["/api/control-plane/deployments", "/api/admin/customer-deployments", "/api/user/sessions"])("leaves independent account/platform authorization to its own guard for %s", async (path) => {
    await expect(requireSupportRequestAccess(actor, path)).resolves.toBeUndefined();
    const derived: AppActor = { kind: "agent", authProvider: "credential", label: "derived", workspaceIds: ["ws-1"], supportOrigin: { userId: "support", workspaceId: "ws-1", version: 1 } };
    await expect(requireSupportRequestAccess(derived, path)).rejects.toMatchObject({ code: "SUPPORT_ACCESS_RESTRICTED" });
  });
  it.each(["/api/integrations/google/connect", "/api/integrations/microsoft/callback", "/api/integrations/slack/install", "/api/integrations/slack/callback", "/api/integrations/connections/conn-1/disconnect", "/api/billing/portal"])("delegates audited provider route %s to its mandatory workspace guard", async (path) => {
    expect(isWorkspaceAuthorizedProviderRoute(path)).toBe(true);
    await expect(requireSupportRequestAccess(actor, path)).resolves.toBeUndefined();
    expect(isWorkspaceAuthorizedProviderRoute(`${path}/export`)).toBe(false);
  });
  it("rechecks derived agent credentials on direct API calls", async () => {
    const agent: AppActor = { kind: "agent", authProvider: "credential", label: "derived", workspaceIds: ["ws-1"], supportOrigin: { userId: "support", workspaceId: "ws-1", version: 1 } };
    await expect(requireSupportRequestAccess(agent, "/api/workspaces/ws-2/documents")).rejects.toThrow();
    expect(membership).toHaveBeenCalledWith({ actor: agent, workspaceId: "ws-2" });
  });
  it("extracts only a whole workspace path segment", () => {
    expect(workspaceIdFromPath("/es/workspaces/ws-1/brain")).toBe("ws-1");
    expect(workspaceIdFromPath("/api/workspaces/create")).toBeNull();
    expect(workspaceIdFromPath("/api/other/workspaces/ws-1")).toBeNull();
  });
});
