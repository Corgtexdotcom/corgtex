import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  evaluateValidationMatrices,
  findValidationMatrixFiles,
  formatValidationOutcomeReport,
  loadValidationMatrices,
} from "./production-validation-outcome-gate.mjs";

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "corgtex-validation-gate-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function matrix(status, overrides = {}) {
  return {
    runId: `${status}-run`,
    status,
    results: [{
      prNumber: 724,
      intent: "Briefing fixture",
      method: "briefing-fixture-production-smoke",
      result: status,
      ...(status === "partial" || status === "blocked" ? { blocker: `${status} blocker` } : {}),
    }],
    cleanupActions: [],
    ...overrides,
  };
}

describe("production validation outcome gate", () => {
  it("finds matrix artifacts recursively", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "root.matrix.json"), "{}\n");
      await writeFile(path.join(dir, "ignored.json"), "{}\n");
      await writeFile(path.join(dir, "lane.matrix.json"), "{}\n");

      const files = await findValidationMatrixFiles(dir);

      expect(files.map((file) => path.basename(file))).toEqual(["lane.matrix.json", "root.matrix.json"]);
    });
  });

  it("passes only when every matrix computes to a pass-like outcome", async () => {
    const outcome = evaluateValidationMatrices([
      { filePath: "client.matrix.json", run: matrix("pass") },
      { filePath: "not-applicable.matrix.json", run: matrix("not production-applicable") },
    ]);

    expect(outcome.status).toBe("passed");
    expect(outcome.failures).toHaveLength(0);
  });

  it("fails when any lane is blocked, partial, or has incomplete cleanup", () => {
    const outcome = evaluateValidationMatrices([
      { filePath: "briefing.matrix.json", run: matrix("partial") },
      {
        filePath: "crm.matrix.json",
        run: matrix("pass", {
          runId: "cleanup-run",
          cleanupActions: [{
            id: "archive:Action:action-1",
            action: "archive",
            target: { type: "Action", id: "action-1" },
            status: "pending",
          }],
        }),
      },
    ]);

    expect(outcome.status).toBe("failed");
    expect(outcome.failures.map((failure) => failure.computedStatus)).toEqual(["partial", "partial"]);
    expect(formatValidationOutcomeReport(outcome)).toContain("partial blocker");
    expect(formatValidationOutcomeReport(outcome)).toContain("cleanup archive:Action:action-1 pending");
  });

  it("fails malformed matrix statuses instead of treating them as pass", () => {
    const outcome = evaluateValidationMatrices([
      {
        filePath: "bad-result.matrix.json",
        run: matrix("pass", {
          results: [{ intent: "Bad result", method: "bad-smoke", result: "failed" }],
        }),
      },
      {
        filePath: "bad-cleanup.matrix.json",
        run: matrix("pass", {
          cleanupActions: [{
            id: "archive:Action:action-1",
            action: "archive",
            target: { type: "Action", id: "action-1" },
            status: "unknown",
          }],
        }),
      },
    ]);

    const report = formatValidationOutcomeReport(outcome);

    expect(outcome.status).toBe("failed");
    expect(outcome.failures.map((failure) => failure.computedStatus)).toEqual(["partial", "partial"]);
    expect(report).toContain("unknown result status");
    expect(report).toContain("unknown cleanup status");
  });

  it("loads matrix files and fails when no matrices exist", async () => {
    await withTempDir(async (dir) => {
      const matrices = await loadValidationMatrices(dir);
      const outcome = evaluateValidationMatrices(matrices);

      expect(matrices).toEqual([]);
      expect(outcome.status).toBe("failed");
      expect(formatValidationOutcomeReport(outcome)).toContain("No production validation matrix artifacts were found.");
    });
  });
});
