import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const requireWorkspaceMembership = vi.fn();
const getFinanceAccessPolicy = vi.fn();

vi.mock("./auth", () => ({
  requireWorkspaceMembership,
}));

vi.mock("./finance", () => ({
  getFinanceAccessPolicy,
}));

const userActor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "reader@example.com",
    displayName: "Reader",
  },
};

function agentActor(scopes: string[]): AppActor {
  return {
    kind: "agent",
    authProvider: "credential",
    label: "knowledge-reader",
    workspaceIds: ["workspace-1"],
    scopes,
  };
}

const insufficientAgentScopeCases: Array<{ label: string; scopes: string[] }> = [
  { label: "no scopes", scopes: [] },
  { label: "Brain read only", scopes: ["brain:read"] },
  { label: "Finance read only", scopes: ["finance:read"] },
];

describe("resolveKnowledgeAccessDomains", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    });
  });

  it("limits a human without Finance read access to workspace knowledge", async () => {
    getFinanceAccessPolicy.mockResolvedValue({
      canRead: false,
      reportImportsEnabled: false,
    });

    const { resolveKnowledgeAccessDomains } = await import("./brain-access");
    await expect(resolveKnowledgeAccessDomains(userActor, "workspace-1"))
      .resolves.toEqual(["WORKSPACE"]);

    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor: userActor,
      workspaceId: "workspace-1",
    });
    expect(getFinanceAccessPolicy).toHaveBeenCalledWith(userActor, "workspace-1");
  });

  it("adds Finance for a human with native Finance read access even when imports are off", async () => {
    getFinanceAccessPolicy.mockResolvedValue({
      canRead: true,
      reportImportsEnabled: false,
    });

    const { resolveKnowledgeAccessDomains } = await import("./brain-access");
    await expect(resolveKnowledgeAccessDomains(userActor, "workspace-1"))
      .resolves.toEqual(["WORKSPACE", "FINANCE"]);
  });

  it.each(insufficientAgentScopeCases)("keeps an agent with $label out of Finance knowledge", async ({ scopes }) => {
    const actor = agentActor(scopes);

    const { resolveKnowledgeAccessDomains } = await import("./brain-access");
    await expect(resolveKnowledgeAccessDomains(actor, "workspace-1"))
      .resolves.toEqual(["WORKSPACE"]);

    expect(getFinanceAccessPolicy).not.toHaveBeenCalled();
  });

  it("adds Finance for an agent only when both knowledge scopes and Finance read policy allow it", async () => {
    const actor = agentActor(["brain:read", "finance:read"]);
    getFinanceAccessPolicy.mockResolvedValue({
      canRead: true,
      reportImportsEnabled: false,
    });

    const { resolveKnowledgeAccessDomains } = await import("./brain-access");
    await expect(resolveKnowledgeAccessDomains(actor, "workspace-1"))
      .resolves.toEqual(["WORKSPACE", "FINANCE"]);

    expect(getFinanceAccessPolicy).toHaveBeenCalledWith(actor, "workspace-1");
  });

  it("keeps a fully scoped agent out of Finance when the native policy denies read access", async () => {
    const actor = agentActor(["brain:read", "finance:read"]);
    getFinanceAccessPolicy.mockResolvedValue({
      canRead: false,
      reportImportsEnabled: true,
    });

    const { resolveKnowledgeAccessDomains } = await import("./brain-access");
    await expect(resolveKnowledgeAccessDomains(actor, "workspace-1"))
      .resolves.toEqual(["WORKSPACE"]);
  });

  it("propagates workspace authorization failures before deriving domains", async () => {
    const error = new Error("not a member");
    requireWorkspaceMembership.mockRejectedValue(error);

    const { resolveKnowledgeAccessDomains } = await import("./brain-access");
    await expect(resolveKnowledgeAccessDomains(userActor, "workspace-1"))
      .rejects.toBe(error);

    expect(getFinanceAccessPolicy).not.toHaveBeenCalled();
  });
});
