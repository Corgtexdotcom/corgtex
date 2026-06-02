import { describe, expect, it } from "vitest";
import { buildAgentAuthoritySummaries } from "./agent-authority-summary";

describe("buildAgentAuthoritySummaries", () => {
  it("derives full and default authority summaries from existing inputs", () => {
    const summaries = buildAgentAuthoritySummaries({
      identities: [{
        id: "agent-1",
        agentKey: "meeting-summary",
        displayName: "Meeting Summary",
        memberType: "INTERNAL",
        isActive: true,
        linkedCredentialId: "cred-1",
        maxSpendPerRunCents: 250,
        maxRunsPerDay: 8,
        maxRunsPerHour: 3,
        circleAssignments: [{ circle: { id: "circle-1", name: "Operations" }, role: { id: "role-1", name: "Meeting Steward" } }],
      }],
      configs: [
        {
          agentKey: "meeting-summary",
          label: "Meeting Summary",
          category: "knowledge",
          costTier: "medium",
          defaultModelTier: "quality",
          enabled: true,
          modelOverride: "openrouter/custom",
          governancePolicy: "Ask for review before publishing summaries.",
        },
        { agentKey: "proposal-drafting", label: "Proposal Drafting", enabled: false, hasGovernancePolicy: false },
      ],
      credentials: [{
        id: "cred-1",
        label: "Claude Desktop",
        scopes: ["meetings:read", "tools:credentials:read", "actions:write"],
        isActive: true,
        lastUsedAt: "2026-06-01T12:00:00.000Z",
        monthlyBudgetCents: 1500,
        dailyCallLimit: 25,
      }],
      recentRuns: [
        { id: "run-older", agentKey: "meeting-summary", status: "COMPLETED", goal: "Summarize sync", createdAt: "2026-06-01T08:00:00.000Z" },
        { id: "run-newer", agentKey: "meeting-summary", status: "WAITING_APPROVAL", goal: "Publish summary", approvalRequired: true, createdAt: "2026-06-02T08:00:00.000Z" },
      ],
      usageByAgent: [{ agentKey: "meeting-summary", callCount: 14, totalCostUsd: "1.75" }],
      runCountsByAgent: [{ agentKey: "meeting-summary", count: 4 }],
      workspaceBudget: { monthlyCostCapUsd: "25", alertThresholdPct: 80 },
    });

    const full = summaries.find((summary) => summary.agentKey === "meeting-summary");
    const fallback = summaries.find((summary) => summary.agentKey === "proposal-drafting");
    expect(full).toMatchObject({
      displayName: "Meeting Summary",
      status: "ACTIVE",
      roleAssignments: [{ circleName: "Operations", roleName: "Meeting Steward" }],
      toolsAndDataAccess: { credentialLabel: "Claude Desktop", scopeCount: 3, writeScopeCount: 2, sensitiveScopeCount: 2 },
      limits: { maxSpendPerRunCents: 250, maxRunsPerDay: 8, maxRunsPerHour: 3, credentialMonthlyBudgetCents: 1500, workspaceMonthlyCostCapUsd: "25" },
      approval: { hasGovernancePolicy: true, pendingApprovalCount: 1 },
      recentActivity: { runCount30d: 4, modelCallCount30d: 14, spend30dUsd: 1.75 },
    });
    expect(full?.approval.latestApprovalRequiredRun?.id).toBe("run-newer");
    expect(full?.recentActivity.latestRun?.id).toBe("run-newer");
    expect(full?.toolsAndDataAccess.scopes.map((scope) => scope.name)).toEqual(["actions:write", "meetings:read", "tools:credentials:read"]);
    expect(fallback).toMatchObject({
      identityId: null,
      displayName: "Proposal Drafting",
      status: "DISABLED",
      memberType: "INTERNAL",
      roleAssignments: [],
      toolsAndDataAccess: { credentialId: null, scopes: [], scopeCount: 0 },
      limits: { maxSpendPerRunCents: null, maxRunsPerDay: null, workspaceBudgetConfigured: true },
      approval: { hasGovernancePolicy: false, pendingApprovalCount: 0, latestApprovalRequiredRun: null },
      recentActivity: { latestRun: null, runCount30d: 0, modelCallCount30d: 0, spend30dUsd: 0 },
    });
  });
});
