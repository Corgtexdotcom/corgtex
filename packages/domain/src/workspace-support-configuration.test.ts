import { beforeEach, describe, expect, it, vi } from "vitest";
const { tx } = vi.hoisted(() => ({ tx: {
  $queryRaw: vi.fn(),
  workspaceSupportGrant: { findUnique: vi.fn() },
  oAuthConnection: { findFirst: vi.fn(), updateMany: vi.fn() },
  communicationInstallation: { findFirst: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
} }));
vi.mock("@corgtex/shared", async importOriginal => ({
  ...await importOriginal<typeof import("@corgtex/shared")>(),
  prisma: { $transaction: (run: (db: typeof tx) => unknown) => run(tx) },
}));
vi.mock("./auth", () => ({ requireDeploymentWorkspaceScope: vi.fn() }));
vi.mock("./role-onboarding", () => ({ closeRoleLifecycleForMember: vi.fn() }));
import { changeSupportConfiguration } from "./workspace-support-configuration";
const actor = { kind: "user" as const, user: { id: "support", email: "support@example.test", displayName: null } };
const updatedAt = new Date("2026-09-15T00:00:00Z");
beforeEach(() => {
  vi.resetAllMocks();
  tx.workspaceSupportGrant.findUnique.mockResolvedValue({ id: "grant", version: 1, isActive: true, role: "SETUP" });
});
describe("configuration concurrent-owner decisions", () => {
  it("refuses reserved demo support invitations before approval or membership writes", async () => {
    await expect(changeSupportConfiguration(actor, "ws", 1, { kind: "addMember", email: "demo@jnj-demo.corgtex.app", role: "CONTRIBUTOR" })).rejects.toMatchObject({ code: "RESERVED_IDENTITY" });
    expect(tx.$queryRaw).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("does not overwrite a concurrent disconnect or consent change", async () => {
    tx.oAuthConnection.findFirst.mockResolvedValue({ id: "connection", provider: "GOOGLE", scopes: [], status: "ACTIVE", syncSettings: {}, updatedAt });
    tx.oAuthConnection.updateMany.mockResolvedValue({ count: 0 });
    await expect(changeSupportConfiguration(actor, "ws", 1, { kind: "oauth", connectionId: "connection", status: "PAUSED", calendar: false, documents: false, email: false })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(tx.oAuthConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "connection", workspaceId: "ws", status: "ACTIVE", updatedAt } }));
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("does not overwrite concurrent communication source admission settings", async () => {
    tx.communicationInstallation.findFirst.mockResolvedValue({ id: "installation", settings: { channelAdmissionMode: "selected" }, updatedAt });
    tx.communicationInstallation.updateMany.mockResolvedValue({ count: 0 });
    await expect(changeSupportConfiguration(actor, "ws", 1, { kind: "communication", installationId: "installation", rawRetentionDays: 14 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(tx.communicationInstallation.updateMany).toHaveBeenCalledWith({ where: { id: "installation", workspaceId: "ws", updatedAt }, data: { settings: { channelAdmissionMode: "selected", rawRetentionDays: 14 } } });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
