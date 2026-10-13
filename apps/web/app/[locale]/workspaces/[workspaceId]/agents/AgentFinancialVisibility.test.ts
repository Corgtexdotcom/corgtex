import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { membership, usage, budget } = vi.hoisted(() => ({membership: vi.fn(), usage: vi.fn(), budget: vi.fn()}));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../../../../../../packages/domain/src/agent-authority-summary"),
  requireWorkspaceMembership: membership, getModelUsageSummary: usage, getModelUsageBudget: budget,
  listAgentIdentities: async () => [{agentKey: "maintenance", displayName: "Maintenance", maxSpendPerRunCents: 12345, maxRunsPerDay: 10}],
  listAgentConfigs: async () => [], listAgentCredentials: async () => [], listAgentRuns: async () => [],
}));
vi.mock("@corgtex/shared", () => ({prisma: {agentRun: {groupBy: async () => []}}}));
vi.mock("./actions", () => ({updateAgentGovernancePolicyAction: vi.fn()}));
vi.mock("./AgentRegistryToggle", () => ({AgentRegistryToggle: () => null}));
vi.mock("../settings/agents/AgentBudgetManager", () => ({AgentBudgetManager: () => React.createElement("span", null, "Budget editor")}));
vi.mock("./AgentSpendLimits", () => ({AgentSpendLimits: () => React.createElement("span", null, "Spend limits")}));
vi.mock("next-intl/server", () => ({getTranslations: async () => (key: string) => key, getFormatter: async () => ({dateTime: () => "date"})}));
import { AgentRegistryTab } from "./AgentRegistryTab";
import { SpendControlTab } from "./SpendControlTab";
const actor = {kind: "user", user: {id: "user"}} as any;
const props = {actor, workspaceId: "ws-1"};
beforeEach(() => {
  vi.stubGlobal("React", React); vi.resetAllMocks(); membership.mockResolvedValue({id: "member", role: "CONTRIBUTOR"});
  usage.mockResolvedValue({totalCostUsd: 1, totalTokens: 30, totalCalls: 1, byAgent: [{agentKey: "maintenance", totalCostUsd: 1}], byModel: [], byDay: []});
  budget.mockResolvedValue({monthlyCostCapUsd: 6789, alertThresholdPct: 80, periodStartDay: 1});
});
describe("agent finance visibility", () => {
  it("keeps the registry visible without querying or rendering money for a non-admin", async () => {
    const html = renderToStaticMarkup(await AgentRegistryTab(props));
    expect(html).toContain("Maintenance"); expect(html).toContain("10 runs/day");
    expect(html).not.toMatch(/\$\d/); expect(html).not.toContain("12345"); expect(html).not.toContain("6789");
    expect(usage).not.toHaveBeenCalled(); expect(budget).not.toHaveBeenCalled();
  });
  it("omits the financial panel without financial calls for a non-admin", async () => {
    expect(await SpendControlTab(props)).toBeNull();
    expect(usage).not.toHaveBeenCalled(); expect(budget).not.toHaveBeenCalled();
  });
  it("uses current admin membership for financial reads and rendering", async () => {
    membership.mockResolvedValue({id: "member", role: "ADMIN"});
    const html = renderToStaticMarkup(await AgentRegistryTab(props));
    expect(html).toContain("$123.45"); expect(html).toContain("$6789.00"); expect(html).toContain("$1.0000");
    expect(usage).toHaveBeenCalledExactlyOnceWith(actor, "ws-1", {periodDays: 30});
    expect(budget).toHaveBeenCalledExactlyOnceWith(actor, "ws-1");
  });
});
