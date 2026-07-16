import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CrmSmoke,
  crmHealthReleaseBlocker,
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

describe("CRM production smoke release validation", () => {
  it("blocks before write-path checks when expected release SHA is missing or drifted", () => {
    expect(crmHealthReleaseBlocker({
      release: {
        gitSha: "older-sha",
      },
    }, "current-sha")).toContain("release.gitSha older-sha");

    expect(crmHealthReleaseBlocker({
      release: {
        gitSha: "current-sha",
        configured: { gitSha: "older-sha" },
        drift: {
          gitSha: true,
          imageTag: true,
          version: false,
          details: ["configured.gitSha=older-sha does not match runtime.gitSha=current-sha"],
        },
      },
    }, "current-sha")).toContain("configured.gitSha=older-sha");
  });

  it("accepts aligned release metadata", () => {
    expect(crmHealthReleaseBlocker({
      release: {
        gitSha: "current-sha",
        configured: { gitSha: "current-sha" },
        drift: {
          gitSha: false,
          imageTag: false,
          version: false,
          details: [],
        },
      },
    }, "current-sha")).toBeNull();
  });
});

describe("CRM production smoke validation matrix", () => {
  it("records one validation result per covered PR number", () => {
    const smoke = new CrmSmoke({
      baseUrl: "https://app.corgtex.com",
      outDir: ".artifacts/test-crm-production-smoke",
      expectedGitSha: null,
      workspaceSelector: { workspaceSlug: "corgtex-validation", explicit: true },
      authEmail: "admin@example.com",
      authPassword: "password",
      requireSafeWorkspace: true,
      headless: true,
      prNumbers: [696, 706],
    });

    smoke.recordValidationOutcome("passed", null, "/tmp/crm-production-smoke.json");

    expect(smoke.validationRun.results.map((result) => result.prNumber)).toEqual([696, 706]);
    expect(smoke.validationRun.results.every((result) => result.result === "pass")).toBe(true);
  });
});

describe("CRM production smoke chat diagnostics", () => {
  it("keeps failing on blank chat responses and writes raw stream diagnostics", async () => {
    const outDir = path.resolve(".artifacts/test-crm-production-smoke-empty-chat");
    await rm(outDir, { recursive: true, force: true });

    const smoke = new CrmSmoke({
      baseUrl: "https://app.corgtex.com",
      outDir,
      expectedGitSha: null,
      workspaceSelector: { workspaceSlug: "corgtex-validation", explicit: true },
      authEmail: "admin@example.com",
      authPassword: "password",
      requireSafeWorkspace: true,
      headless: true,
      prNumbers: [696],
    });
    smoke.cookie = "corgtex-session=test";
    smoke.workspaceId = "workspace-1";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("data: {\"keepAlive\":true}\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    try {
      await expect(smoke.chat("conversation-1", "What CRM account am I viewing?", {
        surface: "crm",
        selectedIds: { accountId: "account-1" },
      })).rejects.toThrow(/Raw stream saved/);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const diagnostic = smoke.results.find((result) => result.name === "chat empty stream diagnostics");
    expect(diagnostic).toBeTruthy();
    expect(diagnostic.path).toBe(path.join(outDir, "chat-empty-1.json"));

    const body = JSON.parse(await readFile(diagnostic.path, "utf8"));
    expect(body.message).toBe("What CRM account am I viewing?");
    expect(body.rawStreamText).toContain("\"keepAlive\":true");
    expect(body.parsedPayloads).toEqual([{ keepAlive: true }]);
  });
});
