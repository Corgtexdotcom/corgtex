import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@corgtex/shared", () => ({ prisma: { $transaction: mocks.transaction }, env: {}, getSupportAuthorizationContext: vi.fn(), runWithSupportOrigin: vi.fn() }));
vi.mock("./auth", () => ({ requireDeploymentWorkspaceScope: vi.fn() }));
vi.mock("./role-onboarding", () => ({ closeRoleLifecycleForMember: vi.fn() }));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));
import { changeWorkspaceSupportGrant } from "./workspace-support-access";
describe("reserved public demo support", () => {
  it("refuses grant creation/reactivation before transaction or writes", async () => {
    const actor = { kind: "user" as const, user: { id: "owner", email: "owner@example.com", displayName: null } };
    await expect(changeWorkspaceSupportGrant(actor, { workspaceId: "client", email: "  DEMO@JNJ-DEMO.CORGTEX.APP ", role: "FULL", isActive: true, expectedVersion: 0 })).rejects.toMatchObject({ code: "RESERVED_IDENTITY" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
