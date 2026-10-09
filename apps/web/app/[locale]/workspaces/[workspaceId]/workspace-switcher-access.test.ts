import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { accessibleSwitcherWorkspaces } from "./workspace-switcher-access";

const mocks = vi.hoisted(() => ({ operator: vi.fn(), memberships: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ isGlobalOperator: mocks.operator }));
vi.mock("@corgtex/shared", () => ({ prisma: { member: { findMany: mocks.memberships } } }));
const actor = { kind: "user", user: { id: "synthetic-operator" } } as AppActor;
const workspaces = [{ id: "member-workspace" }, { id: "discovered-only" }];

describe("switcher operator access", () => {
  beforeEach(() => vi.resetAllMocks());

  it("excludes discovered tenants without active membership", async () => {
    mocks.operator.mockReturnValue(true);
    mocks.memberships.mockResolvedValue([{ workspaceId: "member-workspace" }]);
    expect(await accessibleSwitcherWorkspaces(actor, workspaces)).toEqual([workspaces[0]]);
    expect(mocks.memberships).toHaveBeenCalledWith({
      where: { userId: "synthetic-operator", isActive: true, workspaceId: { in: ["member-workspace", "discovered-only"] } },
      select: { workspaceId: true },
    });
  });

  it("removes a revoked membership on the next server render", async () => {
    mocks.operator.mockReturnValue(true);
    mocks.memberships.mockResolvedValue([]);
    expect(await accessibleSwitcherWorkspaces(actor, workspaces)).toEqual([]);
  });

  it("preserves already authorized non-operator discovery without another lookup", async () => {
    mocks.operator.mockReturnValue(false);
    expect(await accessibleSwitcherWorkspaces(actor, workspaces)).toBe(workspaces);
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it("preserves agent-scoped discovery", async () => {
    const agent = { kind: "agent", workspaceIds: ["member-workspace"] } as AppActor;
    expect(await accessibleSwitcherWorkspaces(agent, [workspaces[0]])).toEqual([workspaces[0]]);
    expect(mocks.operator).not.toHaveBeenCalled();
    expect(mocks.memberships).not.toHaveBeenCalled();
  });
});
