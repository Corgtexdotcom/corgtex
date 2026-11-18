import { describe, expect, it, vi } from "vitest";

import {
  SourceIntakeSmoke,
  normalizeBaseUrl,
  parseSetCookie,
  sourceIntakeAddRouteSuffix,
  sourceIntakeHealthReleaseBlocker,
  sourceIntakeRoutePath,
  sourceIntakeScreenshotFileName,
  sourceWorkflowEventWhere,
  sourceWorkflowJobWhere,
} from "./source-intake-production-smoke.mjs";

describe("source-intake production smoke route contract", () => {
  it("builds explicit Add route targets for source-intake validation", () => {
    expect(sourceIntakeAddRouteSuffix("/workspaces/ws-1")).toBe(
      "/add?kind=paste_text&returnTo=%2Fworkspaces%2Fws-1%2Fsettings%3Ftab%3Ddata-sources",
    );
    expect(sourceIntakeRoutePath("ws-1", {
      kind: "upload_file",
      returnTo: "/workspaces/ws-1/brain",
    })).toBe(
      "/workspaces/ws-1/add?kind=upload_file&returnTo=%2Fworkspaces%2Fws-1%2Fbrain",
    );
  });

  it("uses deterministic screenshot names", () => {
    expect(sourceIntakeScreenshotFileName("Mobile Paste Text Source Intake")).toBe("mobile-paste-text-source-intake.png");
  });
});

describe("source-intake production smoke release validation", () => {
  it("blocks before write checks when runtime or configured release metadata drifts", () => {
    expect(sourceIntakeHealthReleaseBlocker({
      release: {
        gitSha: "older-sha",
      },
    }, "current-sha")).toContain("release.gitSha older-sha");

    expect(sourceIntakeHealthReleaseBlocker({
      release: {
        gitSha: "current-sha",
        configured: { gitSha: "older-sha" },
        drift: {
          gitSha: true,
          imageTag: false,
          version: false,
          details: ["configured.gitSha=older-sha does not match runtime.gitSha=current-sha"],
        },
      },
    }, "current-sha")).toContain("configured.gitSha=older-sha");
  });

  it("accepts aligned release metadata", () => {
    expect(sourceIntakeHealthReleaseBlocker({
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

describe("source-intake production smoke session handling", () => {
  it("normalizes base URLs and session cookies", () => {
    expect(normalizeBaseUrl("https://app.corgtex.com/")).toBe("https://app.corgtex.com");
    expect(parseSetCookie("corgtex-session=abc123; Path=/; HttpOnly")).toBe("corgtex-session=abc123");
  });
});

describe("source-intake production smoke validation matrix", () => {
  it("records one validation result per covered PR number", () => {
    const smoke = new SourceIntakeSmoke({
      baseUrl: "https://app.corgtex.com",
      outDir: ".artifacts/test-source-intake-production-smoke",
      expectedGitSha: null,
      workspaceSelector: { workspaceSlug: "corgtex-validation", explicit: true },
      authEmail: "admin@example.com",
      authPassword: "password",
      headless: true,
      prNumbers: [721, 722],
    });

    smoke.recordValidationOutcome("passed", null, "/tmp/source-intake-production-smoke.json");

    expect(smoke.validationRun.results.map((result) => result.prNumber)).toEqual([721, 722]);
    expect(smoke.validationRun.results.every((result) => result.result === "pass")).toBe(true);
    expect(smoke.validationRun.results[0].intent).toContain("Add/source-intake route contract");
  });

  it("marks failed source-intake validation as partial with a blocker", () => {
    const smoke = new SourceIntakeSmoke({
      baseUrl: "https://app.corgtex.com",
      outDir: ".artifacts/test-source-intake-production-smoke",
      expectedGitSha: null,
      workspaceSelector: { workspaceSlug: "corgtex-validation", explicit: true },
      authEmail: "admin@example.com",
      authPassword: "password",
      headless: true,
      prNumbers: [721],
    });

    smoke.recordValidationOutcome("failed", new Error("demo workspace missing"), "/tmp/source-intake-production-smoke.json");

    expect(smoke.validationRun.results[0]).toMatchObject({
      prNumber: 721,
      result: "partial",
      blocker: "demo workspace missing",
    });
  });
});

describe("source-intake production smoke cleanup contract", () => {
  it("targets source-created events and workflow jobs by source id", () => {
    expect(sourceWorkflowEventWhere("workspace-1", "source-1")).toEqual({
      workspaceId: "workspace-1",
      OR: [
        { aggregateId: "source-1" },
        { payload: { path: ["sourceId"], equals: "source-1" } },
      ],
    });
    expect(sourceWorkflowJobWhere("workspace-1", "source-1", ["event-1"])).toEqual({
      workspaceId: "workspace-1",
      OR: [
        { eventId: { in: ["event-1"] } },
        { payload: { path: ["sourceId"], equals: "source-1" } },
      ],
    });
  });

  async function archiveFixture({
    removal = { response: { status: 200 }, body: { ok: true, id: "source-1", status: "archived" } },
    archived = { id: "source-1", workspaceId: "workspace-1", archivedAt: new Date("2026-11-18T10:00:00Z") },
  } = {}) {
    const order = [];
    const findFirst = vi.fn(async () => { order.push("archive-metadata"); return archived; });
    const smoke = new SourceIntakeSmoke({
      baseUrl: "https://fixture.invalid", outDir: ".artifacts/test-source-intake-production-smoke",
      expectedGitSha: null, workspaceSelector: { workspaceSlug: "corgtex-validation", explicit: true },
      authEmail: "validation@example.test", authPassword: "synthetic", headless: true,
      prNumbers: [721], prisma: { brainSource: { findFirst } },
    });
    smoke.workspace = { id: "workspace-1", slug: "corgtex-validation" };
    smoke.suppressSourceProcessing = vi.fn(async (_id, { reason }) => {
      order.push(reason);
      return {};
    });
    smoke.assertSourceWorkflowArtifactsCleared = vi.fn(async () => { order.push("artifacts-cleared"); });
    smoke.requestJson = vi.fn(async (path, init = {}) => {
      if (path.endsWith("/text-ingest")) {
        const input = JSON.parse(init.body);
        return { body: { id: "source-1", title: input.title, ingestionGuidanceMd: input.ingestionGuidanceMd.trim() } };
      }
      if (init.method === "DELETE") { order.push("native-delete"); return removal; }
      // Actual archived-read policy withholds the archived record. Cleanup must
      // consume the native removal fact instead of expecting this list to expose it.
      return { body: { items: path.includes("archiveFilter=archived") ? [] : [{ id: "source-1" }] } };
    });
    await smoke.createTextSource();
    order.length = 0;
    return { smoke, order, findFirst, run: () => smoke.cleanupRegistry.runAll({ throwOnFailure: false }) };
  }

  it("proves native archive and scoped metadata before post-delete cleanup without reading archived bodies", async () => {
    const f = await archiveFixture();
    const result = await f.run();
    expect(result.failed).toEqual([]);
    expect(result.completed).toHaveLength(1);
    expect(f.order).toEqual(["cleanup-before-archive", "native-delete", "archive-metadata",
      "cleanup-after-archive", "artifacts-cleared"]);
    expect(f.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: "source-1", workspaceId: "workspace-1" },
      select: { id: true, workspaceId: true, archivedAt: true },
    });
    expect(f.smoke.requestJson.mock.calls.some(([path]) => path.includes("archiveFilter=archived"))).toBe(false);
  });

  it.each([
    ["pending", { response: { status: 202 }, body: { ok: false, id: "source-1", status: "pending" } }],
    ["wrong source", { response: { status: 200 }, body: { ok: true, id: "other-source", status: "archived" } }],
    ["unconfirmed", { response: { status: 200 }, body: { ok: false, id: "source-1", status: "archived" } }],
  ])("rejects %s native removal without treating cleanup as archive proof", async (_name, removal) => {
    const f = await archiveFixture({ removal });
    const result = await f.run();
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error.message).toContain("exact completed source archive");
    expect(f.findFirst).not.toHaveBeenCalled();
    expect(f.order).toEqual(["cleanup-before-archive", "native-delete"]);
  });

  it.each([
    ["missing", null],
    ["unarchived", { id: "source-1", workspaceId: "workspace-1", archivedAt: null }],
    ["wrong workspace", { id: "source-1", workspaceId: "other-workspace", archivedAt: new Date() }],
    ["wrong source", { id: "other-source", workspaceId: "workspace-1", archivedAt: new Date() }],
    ["invalid timestamp", { id: "source-1", workspaceId: "workspace-1", archivedAt: new Date(NaN) }],
  ])("rejects %s stored metadata before post-delete cleanup", async (_name, archived) => {
    const f = await archiveFixture({ archived });
    const result = await f.run();
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error.message).toContain("archived source record");
    expect(f.order).toEqual(["cleanup-before-archive", "native-delete", "archive-metadata"]);
  });

  it("registers source cleanup before asserting returned source fields", async () => {
    const smoke = new SourceIntakeSmoke({
      baseUrl: "https://app.corgtex.com",
      outDir: ".artifacts/test-source-intake-production-smoke",
      expectedGitSha: null,
      workspaceSelector: { workspaceSlug: "corgtex-validation", explicit: true },
      authEmail: "admin@example.com",
      authPassword: "password",
      headless: true,
      prNumbers: [721],
      prisma: {},
    });
    smoke.workspace = { id: "workspace-1", slug: "corgtex-validation" };
    smoke.suppressSourceProcessing = vi.fn().mockResolvedValue({
      eventsDeleted: 0,
      workflowJobsDeleted: 0,
      agentRunsDeleted: 0,
      knowledgeChunksDeleted: 0,
      articleSourceRefsRemoved: 0,
      brainArticlesDeleted: 0,
      contextGraphRecordsDeleted: 0,
      companyUnderstandingRecordsDeleted: 0,
    });
    smoke.requestJson = vi.fn(async (routePath) => {
      if (routePath.includes("/data-sources/text-ingest")) {
        return {
          body: {
            id: "source-1",
            title: "unexpected title",
            ingestionGuidanceMd: "unexpected guidance",
          },
        };
      }
      throw new Error(`unexpected request: ${routePath}`);
    });

    await expect(smoke.createTextSource()).rejects.toThrow("text-ingest did not persist the expected title");

    expect(smoke.suppressSourceProcessing).toHaveBeenCalledWith("source-1", { reason: "post-create-before-assertions" });
    expect(smoke.validationRun.cleanupActions).toMatchObject([
      {
        id: "archive:BrainSource:source-1",
        action: "archive",
        target: { type: "BrainSource", id: "source-1" },
      },
    ]);
    expect(smoke.validationRun.createdRecords).toMatchObject([
      {
        type: "BrainSource",
        id: "source-1",
        cleanupActionId: "archive:BrainSource:source-1",
      },
    ]);
  });
});
