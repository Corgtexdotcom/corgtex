import { describe, expect, it } from "vitest";

import {
  crmScreenshotFileName,
  crmVisualTargets,
  evaluateKanbanSnapshot,
  parseActivityId,
  parsePendingOperationId,
} from "./crm-production-smoke.mjs";

describe("CRM production smoke visual targets", () => {
  it("covers the CRM pages and view modes required for production visual proof", () => {
    const targets = crmVisualTargets("workspace-1", "account-1");

    expect(targets.map((target) => target.name)).toEqual([
      "dashboard",
      "accounts-table",
      "accounts-list",
      "pipeline-kanban",
      "pipeline-table",
      "pipeline-list",
      "activity-list",
      "activity-table",
      "suggestions-list",
      "suggestions-table",
      "suggestions-kanban",
      "account-detail-pipeline",
    ]);
    expect(targets.filter((target) => target.kanban).map((target) => target.name)).toEqual([
      "pipeline-kanban",
      "suggestions-kanban",
      "account-detail-pipeline",
    ]);
  });

  it("preserves explicit view query params for each mode-specific route", () => {
    const routes = new Map(crmVisualTargets("workspace-1", "account-1").map((target) => [target.name, target.route]));

    expect(routes.get("accounts-table")).toBe("/workspaces/workspace-1/leads/accounts?view=table");
    expect(routes.get("accounts-list")).toBe("/workspaces/workspace-1/leads/accounts?view=list");
    expect(routes.get("pipeline-kanban")).toBe("/workspaces/workspace-1/leads/pipeline?view=kanban");
    expect(routes.get("pipeline-table")).toBe("/workspaces/workspace-1/leads/pipeline?view=table");
    expect(routes.get("pipeline-list")).toBe("/workspaces/workspace-1/leads/pipeline?view=list");
    expect(routes.get("activity-list")).toBe("/workspaces/workspace-1/leads/activity?view=list");
    expect(routes.get("activity-table")).toBe("/workspaces/workspace-1/leads/activity?view=table");
    expect(routes.get("suggestions-list")).toBe("/workspaces/workspace-1/leads/suggestions?view=list");
    expect(routes.get("suggestions-table")).toBe("/workspaces/workspace-1/leads/suggestions?view=table");
    expect(routes.get("suggestions-kanban")).toBe("/workspaces/workspace-1/leads/suggestions?view=kanban");
    expect(routes.get("account-detail-pipeline")).toBe("/workspaces/workspace-1/leads/accounts/account-1?view=pipeline");
  });

  it("names screenshots by target and theme", () => {
    expect(crmScreenshotFileName("pipeline-kanban", "dark")).toBe("pipeline-kanban-dark.png");
    expect(crmScreenshotFileName("dashboard", "light")).toBe("dashboard-light.png");
  });
});

describe("CRM production smoke Kanban assertions", () => {
  it("accepts visible Kanban cards when the page can scroll", () => {
    expect(evaluateKanbanSnapshot({
      boardVisible: true,
      cardCount: 2,
      clippedWithoutPageScrollCount: 0,
    })).toBeNull();
  });

  it("rejects missing Kanban boards or cards", () => {
    expect(evaluateKanbanSnapshot({
      boardVisible: false,
      cardCount: 1,
      clippedWithoutPageScrollCount: 0,
    })).toContain("not visible");
    expect(evaluateKanbanSnapshot({
      boardVisible: true,
      cardCount: 0,
      clippedWithoutPageScrollCount: 0,
    })).toContain("did not render");
  });

  it("rejects cards clipped below a non-scrollable viewport", () => {
    expect(evaluateKanbanSnapshot({
      boardVisible: true,
      cardCount: 3,
      clippedWithoutPageScrollCount: 1,
    })).toContain("extended below the viewport");
  });
});

describe("CRM production smoke pending operation parsing", () => {
  it("extracts pending operation and activity IDs from deterministic chat output", () => {
    expect(parsePendingOperationId("Pending operation ID: 123e4567-e89b-12d3-a456-426614174000")).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(parseActivityId("Confirmed pending operation ID: op-1\nActivity ID: activity-1")).toBe("activity-1");
  });

  it("fails loudly when chat omits the pending operation contract", () => {
    expect(() => parsePendingOperationId("Please say yes.")).toThrow("pending operation ID");
  });
});
