import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, requireWorkspaceMembershipMock, recorderSnapshotMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    workspaceEnterpriseService: { findMany: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  requireWorkspaceMembershipMock: vi.fn(),
  recorderSnapshotMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: requireWorkspaceMembershipMock }));
vi.mock("./meeting-recorders", () => ({ getMeetingRecorderEnterpriseServiceSnapshot: recorderSnapshotMock }));

const actor: AppActor = {
  kind: "user",
  user: { id: "admin-1", email: "admin@example.com", displayName: "Admin", globalRole: "USER" },
};
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "service-1",
    serviceKey: "AI_WORKSPACE",
    ownershipMode: "CUSTOMER_MANAGED",
    displayName: "Managed AI workspace",
    healthStatus: "NEEDS_SETUP",
    ...overrides,
  };
}

describe("enterprise services domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1", workspaceId: "workspace-1", userId: "admin-1", role: "ADMIN", isActive: true });
    recorderSnapshotMock.mockResolvedValue({
      providerKey: "RECALL_AI",
      ownershipMode: "CORGTEX_MANAGED",
      healthStatus: "ACTIVE",
      lastError: null,
      usageLabel: "25 min this month",
      usageDetail: "25 of 6000 recorder minutes used in the current billing period.",
      readinessChecks: [{ key: "calendar_source", label: "Recorder calendar", ok: true, detail: "Calendar source synced." }],
    });
  });

  it("merges static services, persisted rows, and live recorder state", async () => {
    const { listWorkspaceEnterpriseServiceStates } = await import("./enterprise-services");
    prismaMock.workspaceEnterpriseService.findMany.mockResolvedValue([
      row({ id: "service-ai", serviceKey: "AI_WORKSPACE", ownershipMode: "CORGTEX_MANAGED", healthStatus: "ACTIVE", providerKey: "OPENWORK" }),
    ]);

    const states = await listWorkspaceEnterpriseServiceStates(actor, "workspace-1");
    const recorder = states.find((service) => service.key === "meeting_recorder");
    const aiWorkspace = states.find((service) => service.key === "ai_workspace");

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "workspace-1" });
    expect(states.map((service) => service.key)).toEqual(["meeting_recorder", "ai_workspace", "integrations", "workers", "support"]);
    expect(recorder).toMatchObject({
      ownershipMode: "CORGTEX_MANAGED",
      healthStatus: "ACTIVE",
      providerKey: "RECALL_AI",
      usageLabel: "25 min this month",
      readinessChecks: [expect.objectContaining({ key: "calendar_source", ok: true })],
    });
    expect(aiWorkspace).toMatchObject({ persistedId: "service-ai", ownershipMode: "CORGTEX_MANAGED", providerKey: "OPENWORK" });
  });

  it("requests CORGTEX-managed service ownership and records audit", async () => {
    const { requestManagedEnterpriseService } = await import("./enterprise-services");
    prismaMock.workspaceEnterpriseService.upsert.mockResolvedValue(row({ id: "service-support", serviceKey: "SUPPORT" }));

    await requestManagedEnterpriseService(actor, {
      workspaceId: "workspace-1",
      serviceKey: "support",
      noteMd: "  Need rollout support.  ",
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "workspace-1", allowedRoles: ["ADMIN"] });
    expect(prismaMock.workspaceEnterpriseService.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ ownershipMode: "CORGTEX_MANAGED", supportNotesMd: "Need rollout support." }),
      create: expect.objectContaining({ serviceKey: "SUPPORT", ownershipMode: "CORGTEX_MANAGED", supportNotesMd: "Need rollout support." }),
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "enterprise_service.request_managed",
        entityId: "service-support",
        meta: expect.objectContaining({ serviceKey: "support", supportEscalationStatus: "REQUESTED" }),
      }),
    });
  });
});
