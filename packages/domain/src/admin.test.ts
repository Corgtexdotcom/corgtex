import { describe, it, expect, vi } from "vitest";
import { 
  listAllWorkspaces, 
  adminTriggerPasswordReset, 
  getOperatorOverview,
  listAllWorkspacesEnriched,
  getWorkspaceAdminDetail,
  adminCreateMember,
  adminUpdateMember,
  probeExternalInstanceHealth,
  adminCreateWorkspace,
  adminDeactivateMember
} from "./admin";

// Mock auth checks so we don't need real operators
vi.mock("./auth", () => ({
  requireGlobalOperator: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
}));

// Mock workspace creation
vi.mock("./workspaces", () => ({
  createWorkspace: vi.fn().mockResolvedValue({ id: "ws_new" }),
}));

// We rely on vitest environment matching Prisma or just having basic mock capability
// Instead of full integration testing here for all Prisma calls, we can do some sanity checks.
// Actually, since Corgtex uses an integration test db setup via docker-compose, 
// we will just write a basic test block. In a real integration setup, these would connect to the test db.

describe("Platform Admin Tools", () => {
  const dummyActor = { userId: "operator_1" } as any;

  it("exports the required admin functions", () => {
    expect(listAllWorkspaces).toBeDefined();
    expect(adminTriggerPasswordReset).toBeDefined();
    expect(getOperatorOverview).toBeDefined();
    expect(listAllWorkspacesEnriched).toBeDefined();
    expect(getWorkspaceAdminDetail).toBeDefined();
    expect(adminCreateMember).toBeDefined();
    expect(adminUpdateMember).toBeDefined();
    expect(probeExternalInstanceHealth).toBeDefined();
    expect(adminCreateWorkspace).toBeDefined();
    expect(adminDeactivateMember).toBeDefined();
  });
});
