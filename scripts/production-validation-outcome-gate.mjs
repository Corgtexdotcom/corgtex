#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  aggregateValidationRunStatus,
  isValidationResultStatus,
} from "./lib/production-validation.mjs";

const ACCEPTED_OUTCOME_STATUSES = new Set(["pass", "not production-applicable"]);
const CLEANUP_COMPLETE_STATUSES = new Set(["completed", "skipped"]);
const CLEANUP_KNOWN_STATUSES = new Set(["pending", "running", "completed", "skipped", "failed"]);

function tableCell(value) {
  const text = String(value ?? "n/a").replace(/\s+/g, " ").trim() || "n/a";
  return text.replace(/\|/g, "\\|");
}

function normalizeMatrixRun(run, filePath) {
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new Error(`${filePath} must contain a validation run object.`);
  }
  return {
    ...run,
    runId: String(run.runId ?? path.basename(filePath)),
    status: isValidationResultStatus(run.status) ? run.status : null,
    results: Array.isArray(run.results) ? run.results : [],
    cleanupActions: Array.isArray(run.cleanupActions) ? run.cleanupActions : [],
    blockers: Array.isArray(run.blockers) ? run.blockers : [],
  };
}

function resultBlockers(run) {
  const blockers = run.results
    .filter((result) => result?.result === "partial" || result?.result === "blocked")
    .map((result) => ({
      prNumber: result.prNumber ?? null,
      intent: result.intent ?? "Validation result",
      method: result.method ?? null,
      result: result.result,
      blocker: result.blocker ?? "No blocker reason was recorded.",
    }));

  for (const result of run.results.filter((item) => !isValidationResultStatus(item?.result))) {
    blockers.push({
      prNumber: result?.prNumber ?? null,
      intent: result?.intent ?? "Validation result",
      method: result?.method ?? null,
      result: "partial",
      blocker: `Validation matrix contained unknown result status ${JSON.stringify(result?.result ?? null)}.`,
    });
  }

  return blockers;
}

function cleanupBlockers(run) {
  return run.cleanupActions
    .filter((entry) => !CLEANUP_COMPLETE_STATUSES.has(entry?.status))
    .map((entry) => ({
      id: entry.id ?? `${entry.action ?? "cleanup"}:${entry.target?.type ?? "target"}:${entry.target?.id ?? "unknown"}`,
      status: entry.status ?? "unknown",
      message: CLEANUP_KNOWN_STATUSES.has(entry?.status)
        ? entry.message ?? "Cleanup did not complete."
        : `Validation matrix contained unknown cleanup status ${JSON.stringify(entry?.status ?? null)}.`,
    }));
}

function laneLabel(run) {
  const methods = [...new Set(run.results.map((result) => result?.method).filter(Boolean))];
  if (methods.length === 1) return methods[0];
  return run.metadata?.script ?? run.tenant?.slug ?? run.runId;
}

export async function findValidationMatrixFiles(rootDir) {
  const root = path.resolve(rootDir);
  const files = [];

  async function walk(dir) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".matrix.json")) {
        files.push(entryPath);
      }
    }
  }

  await walk(root);
  return files.sort();
}

export async function loadValidationMatrices(rootDir) {
  const files = await findValidationMatrixFiles(rootDir);
  return Promise.all(files.map(async (filePath) => {
    const raw = await readFile(filePath, "utf8");
    return {
      filePath,
      run: normalizeMatrixRun(JSON.parse(raw), filePath),
    };
  }));
}

export function evaluateValidationMatrices(matrices) {
  const runs = matrices.map(({ filePath, run }) => {
    const blockers = resultBlockers(run);
    const cleanup = cleanupBlockers(run);
    const malformed = blockers.some((blocker) => blocker.blocker.startsWith("Validation matrix contained unknown result status"))
      || cleanup.some((entry) => entry.message.startsWith("Validation matrix contained unknown cleanup status"));
    const computedStatus = malformed ? "partial" : aggregateValidationRunStatus(run);
    return {
      filePath,
      runId: run.runId,
      lane: laneLabel(run),
      reportedStatus: run.status,
      computedStatus,
      accepted: ACCEPTED_OUTCOME_STATUSES.has(computedStatus),
      blockers,
      cleanup,
      resultCount: run.results.length,
    };
  });

  const failures = runs.filter((run) => !run.accepted);
  return {
    status: matrices.length === 0 || failures.length > 0 ? "failed" : "passed",
    matrixCount: matrices.length,
    runs,
    failures,
  };
}

export function formatValidationOutcomeReport(outcome) {
  const lines = [
    "# Production Validation Outcome",
    "",
    `- Status: ${outcome.status}`,
    `- Matrix files: ${outcome.matrixCount}`,
    "",
    "| Lane | Run | Reported | Computed | Results | Matrix |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const run of outcome.runs) {
    lines.push(`| ${tableCell(run.lane)} | ${tableCell(run.runId)} | ${tableCell(run.reportedStatus)} | ${tableCell(run.computedStatus)} | ${tableCell(run.resultCount)} | ${tableCell(run.filePath)} |`);
  }

  if (outcome.runs.length === 0) {
    lines.push("| n/a | n/a | n/a | failed | 0 | No production validation matrix artifacts were found. |");
  }

  if (outcome.failures.length > 0) {
    lines.push("", "## Blocking Outcomes", "");
    for (const failure of outcome.failures) {
      lines.push(`- ${failure.lane}: ${failure.computedStatus}`);
      for (const blocker of failure.blockers) {
        const pr = blocker.prNumber ? `#${blocker.prNumber} ` : "";
        lines.push(`  - ${pr}${blocker.result}: ${blocker.blocker}`);
      }
      for (const cleanup of failure.cleanup) {
        lines.push(`  - cleanup ${cleanup.id} ${cleanup.status}: ${cleanup.message}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const rootDir = process.argv[2] || ".artifacts/production-validation";
  const matrices = await loadValidationMatrices(rootDir);
  const outcome = evaluateValidationMatrices(matrices);
  const report = formatValidationOutcomeReport(outcome);
  process.stdout.write(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
  }
  if (outcome.status !== "passed") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
