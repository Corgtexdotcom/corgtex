import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
const mocks = vi.hoisted(() => ({ groupBy: vi.fn(), membership: vi.fn(), transaction: vi.fn() }));
vi.mock("@corgtex/shared", async importOriginal => ({ ...await importOriginal<typeof import("@corgtex/shared")>(),
  prisma: { agentRun: { groupBy: mocks.groupBy }, $transaction: mocks.transaction } }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: mocks.membership }));
vi.mock("./proposals", () => ({ getProposal: vi.fn() }));
import { getAgentRunOperationalCounts } from "./agent-runs";
const actor = { kind: "user", user: { id: "reader" } } as AppActor;
const tx = { agentRun: { groupBy: mocks.groupBy } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async callback => callback(tx));
  mocks.membership.mockResolvedValue({ role: "CONTRIBUTOR" });
  mocks.groupBy.mockImplementation(async ({ where }) => where.status ? [{ agentKey: "pending-only", _count: { _all: 5001 } }] : [{ agentKey: "recent", _count: { _all: 24 } }]);
});
describe("operational agent run counts", () => {
  it("returns exact scalar groups in the caller workspace without hydrating content or child histories", async () => {
    expect(await getAgentRunOperationalCounts(actor, "workspace-1")).toEqual({
      pendingApprovalCountsByAgent: [{ agentKey: "pending-only", count: 5001 }],
      runCountsByAgent: [{ agentKey: "recent", count: 24 }],
    });
    expect(mocks.groupBy).toHaveBeenCalledTimes(2);
    expect(mocks.groupBy.mock.calls.every(([query]) => query.where.workspaceId === "workspace-1" && !query.include && !query.select)).toBe(true);
    expect(mocks.membership).toHaveBeenNthCalledWith(1, { actor, workspaceId: "workspace-1", tx });
    expect(mocks.membership).toHaveBeenNthCalledWith(2, { actor, workspaceId: "workspace-1", tx });
  });
  it("does not query counts for a nonmember", async () => {
    mocks.membership.mockRejectedValueOnce(Object.assign(new Error("Not a member"), { code: "NOT_A_MEMBER" }));
    await expect(getAgentRunOperationalCounts(actor, "foreign")).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });
  it("withholds collected counts when membership is withdrawn before release", async () => {
    mocks.membership.mockResolvedValueOnce({ role: "ADMIN" }).mockRejectedValueOnce(Object.assign(new Error("Membership withdrawn"), { code: "NOT_A_MEMBER" }));
    await expect(getAgentRunOperationalCounts(actor, "workspace-1")).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(mocks.groupBy).toHaveBeenCalledTimes(2);
  });
});
