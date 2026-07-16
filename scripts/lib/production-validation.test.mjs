import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createValidationCleanupRegistry,
  createValidationRun,
  finalizeValidationRun,
  formatValidationReport,
  normalizeValidationResultStatus,
  parseValidationPrNumbers,
  productionValidationTag,
  recordValidationResult,
  runWithValidationCleanup,
  writeValidationArtifacts,
} from "./production-validation.mjs";

describe("production validation tags and statuses", () => {
  it("builds the canonical production validation record prefix", () => {
    expect(productionValidationTag({
      date: new Date("2026-07-16T12:34:56.000Z"),
      prNumber: "691",
      runId: "prod-verify-123",
    })).toBe("PROD-VERIFY 2026-07-16 PR-691 prod-verify-123");
  });

  it("normalizes PR number lists and rejects unknown result statuses", () => {
    expect(parseValidationPrNumbers("691, 692,691")).toEqual([691, 692]);
    expect(normalizeValidationResultStatus("pass")).toBe("pass");
    expect(() => normalizeValidationResultStatus("failed")).toThrow("Validation result must be one of");
  });

  it("requires blocker details for partial and blocked validation results", () => {
    const run = createValidationRun({ runId: "run-1", prNumbers: [691], tenant: "internal-validation" });

    expect(() => recordValidationResult(run, {
      intent: "CRM writeback",
      method: "crm-production-smoke",
      result: "partial",
    })).toThrow("partial validation results must include a blocker reason");

    recordValidationResult(run, {
      intent: "CRM writeback",
      method: "crm-production-smoke",
      result: "partial",
      blocker: "Missing smoke credential.",
      evidence: [{ type: "log", path: ".artifacts/run/log.txt" }],
    });

    expect(run.results).toHaveLength(1);
    expect(run.results[0].prNumber).toBe(691);
    expect(run.blockers[0].blocker).toBe("Missing smoke credential.");
  });
});

describe("production validation cleanup registry", () => {
  it("records created records and runs cleanup in finally after operation failure", async () => {
    const run = createValidationRun({ runId: "run-cleanup", prNumbers: [691], tenant: { slug: "validation" } });
    const registry = createValidationCleanupRegistry(run);
    const calls = [];

    registry.add({
      action: "archive",
      target: { type: "Action", id: "action-1", label: "temporary action" },
      runner: async () => {
        calls.push("archive action-1");
        return "Archived temporary action.";
      },
    });

    await expect(runWithValidationCleanup(registry, async () => {
      throw new Error("smoke failed");
    })).rejects.toThrow("smoke failed");

    expect(calls).toEqual(["archive action-1"]);
    expect(run.createdRecords).toMatchObject([{ type: "Action", id: "action-1", cleanupActionId: "archive:Action:action-1" }]);
    expect(run.cleanupActions).toMatchObject([{ status: "completed", message: "Archived temporary action." }]);
  });

  it("does not rerun completed cleanup actions", async () => {
    const run = createValidationRun({ runId: "run-idempotent" });
    const registry = createValidationCleanupRegistry(run);
    let count = 0;
    registry.add({
      id: "complete:activity-1",
      action: "complete",
      target: { type: "CrmActivity", id: "activity-1" },
      runner: async () => {
        count += 1;
      },
    });

    await registry.runAll();
    await registry.runAll();

    expect(count).toBe(1);
    expect(run.cleanupActions[0].attempts).toBe(1);
  });
});

describe("production validation artifacts", () => {
  it("writes a machine-readable matrix and a Markdown report", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "corgtex-validation-"));
    try {
      const run = createValidationRun({
        runId: "run-artifacts",
        prNumbers: [691],
        tenant: { id: "ws-1", slug: "internal-validation" },
        startedAt: new Date("2026-07-16T00:00:00.000Z"),
      });
      recordValidationResult(run, {
        intent: "Release metadata",
        method: "telemetry-release-smoke",
        result: "pass",
        evidence: ["health and telemetry share release SHA"],
      });

      const files = await writeValidationArtifacts(run, outDir);
      const json = JSON.parse(await readFile(files.jsonPath, "utf8"));
      const markdown = await readFile(files.markdownPath, "utf8");

      expect(json.status).toBe("pass");
      expect(json.artifacts.map((artifact) => artifact.type)).toEqual(["matrix-json", "report-markdown"]);
      expect(markdown).toContain("# Production Validation Run run-artifacts");
      expect(markdown).toContain("| #691 | Release metadata | internal-validation | telemetry-release-smoke | pass | n/a | health and telemetry share release SHA |");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("aggregates cleanup failures into a partial run status", () => {
    const run = createValidationRun({ runId: "run-partial", prNumbers: [691] });
    recordValidationResult(run, {
      intent: "CRM writeback",
      method: "crm-production-smoke",
      result: "pass",
    });
    run.cleanupActions.push({
      id: "archive:Action:action-1",
      action: "archive",
      target: { type: "Action", id: "action-1" },
      status: "failed",
    });

    finalizeValidationRun(run, { finishedAt: new Date("2026-07-16T01:00:00.000Z") });

    expect(run.status).toBe("partial");
    expect(formatValidationReport(run)).toContain("| archive | Action:action-1 | failed | n/a |");
  });

  it("treats unexecuted cleanup as a partial run", () => {
    const run = createValidationRun({ runId: "run-pending-cleanup", prNumbers: [691] });
    recordValidationResult(run, {
      intent: "CRM writeback",
      method: "crm-production-smoke",
      result: "pass",
    });
    run.cleanupActions.push({
      id: "complete:CrmActivity:activity-1",
      action: "complete",
      target: { type: "CrmActivity", id: "activity-1" },
      status: "pending",
    });

    finalizeValidationRun(run);

    expect(run.status).toBe("partial");
  });
});
