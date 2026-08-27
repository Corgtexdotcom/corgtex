import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ACTION_PROVEN_BODY,
  GOAL_PROGRESS,
  fetchJson,
  sanitize,
  verifyGitLineage,
  PR976_FILES,
  TARGET_SHA,
  assertActionNoEffect,
  assertActionProofResponse,
  assertGoalStatusProof,
  assertGoalProofResponse,
  assertReleaseRuntime,
  expectVersionConflictStatus,
  terminalizeUntilSettled,
} from "./pr976-action-goal-production-smoke.mjs";

function server(handler) {
  return new Promise((resolve) => {
    const instance = createServer(handler);
    instance.listen(0, "127.0.0.1", () => {
      const address = instance.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => instance.close(done)),
      });
    });
  });
}

function retryablePendingReceipt() {
  return { receipt: { outcome: "PENDING", failureCode: "RETRYABLE_TARGET_CLEANUP_FAILED" } };
}

function terminalHarness(results, options = {}) {
  let clock = options.startMs ?? 0;
  const calls = [];
  const sleeps = [];
  return {
    calls,
    sleeps,
    now: () => clock,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      clock += delayMs;
    },
    send: async (payload, timeoutMs) => {
      calls.push({ payload, timeoutMs, at: clock });
      if (options.callElapsedMs) clock += options.callElapsedMs;
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("pr976 action/goal production smoke driver", () => {
  it("keeps the abort deadline active through stalled body reads", async () => {
    const app = await server((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    try {
      await expect(fetchJson(app.url, {}, { timeoutMs: 25 })).rejects.toThrow(/aborted|deadline|BodyStreamBuffer/i);
    } finally {
      await app.close();
    }
  });

  it("rejects oversized response bodies before parsing", async () => {
    const app = await server((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: "x".repeat(128) }));
    });
    try {
      await expect(fetchJson(app.url, {}, { maxBytes: 32 })).rejects.toThrow("RESPONSE_TOO_LARGE");
    } finally {
      await app.close();
    }
  });

  it("sanitizes cookies, bearer tokens, credential tokens, and passwords", () => {
    const clean = sanitize({
      credentialToken: "agentc-secret",
      headers: { authorization: "Bearer abc", cookie: "corgtex_session=raw" },
      nested: { password: "secret" },
    });
    expect(JSON.stringify(clean)).not.toMatch(/agentc-|Bearer|corgtex_session|secret/);
  });

  it("pins the exact twelve PR 976 files for successor equality", () => {
    expect(TARGET_SHA).toBe("086cec6d25f3457ce7b6858aa8c8f31ceb0cc771");
    expect(PR976_FILES).toHaveLength(12);
    expect(PR976_FILES).toContain("apps/web/app/[locale]/workspaces/[workspaceId]/goals/actions.ts");
  });

  it("requires aggregate and runtime release SHAs, runtime source, and zero drift", () => {
    const expected = "1".repeat(40);
    expect(() => assertReleaseRuntime({
      gitSha: expected,
      runtime: { gitSha: expected, source: "container" },
      image: { gitSha: expected, source: "image_stamp", valid: true },
      drift: { gitSha: false, imageTag: false, version: false },
    }, expected)).not.toThrow();
    expect(() => assertReleaseRuntime({
      gitSha: expected,
      runtime: { gitSha: "2".repeat(40), source: "container" },
      image: { gitSha: expected, source: "image_stamp", valid: true },
      drift: { gitSha: false, imageTag: false, version: false },
    }, expected)).toThrow("SERVING_RUNTIME_SHA_MISMATCH");
    expect(() => assertReleaseRuntime({
      gitSha: expected,
      runtime: { gitSha: expected },
      image: { gitSha: expected, source: "image_stamp", valid: true },
      drift: { gitSha: false, imageTag: false, version: false },
    }, expected)).toThrow("SERVING_RUNTIME_SOURCE_MISSING");
    expect(() => assertReleaseRuntime({
      gitSha: expected,
      runtime: { gitSha: expected, source: "container" },
      image: { gitSha: null, source: "missing", valid: false },
      drift: { gitSha: false, imageTag: false, version: false },
    }, expected)).toThrow("SERVING_IMAGE_SHA_MISMATCH");
    expect(() => assertReleaseRuntime({
      gitSha: expected,
      runtime: { gitSha: expected, source: "container" },
      image: { gitSha: expected, source: "image_stamp", valid: true },
      drift: { gitSha: true, imageTag: false, version: false },
    }, expected)).toThrow("SERVING_RELEASE_DRIFT");
  });

  it("fails closed when PR 976 file equality drifts", () => {
    expect(() => verifyGitLineage("0000000000000000000000000000000000000000")).toThrow(/Command failed/);
  });

  it("requires an exact internal stale-write status", () => {
    expect(() => expectVersionConflictStatus({ status: "VERSION_CONFLICT" })).not.toThrow();
    expect(() => expectVersionConflictStatus({ status: "NOT_VERSION_CONFLICT" })).toThrow("VERSION_CONFLICT_NOT_RETURNED");
  });

  it("proves Action stale writes are exact no-effect writes", () => {
    assertActionProofResponse({ action: { id: "action-1", bodyMd: ACTION_PROVEN_BODY, version: 2 } }, "action-1", 1);
    assertActionNoEffect({ action: { id: "action-1", bodyMd: ACTION_PROVEN_BODY, version: 2 } }, "action-1", 2);
    expect(() => assertActionNoEffect({ action: { id: "action-1", bodyMd: ACTION_PROVEN_BODY, version: 3 } }, "action-1", 2)).toThrow("ACTION_STALE_NO_EFFECT_UNPROVEN");
    expect(() => assertActionNoEffect({ action: { id: "action-1", bodyMd: `${ACTION_PROVEN_BODY}:forbidden-stale`, version: 2 } }, "action-1", 2)).toThrow("ACTION_STALE_NO_EFFECT_UNPROVEN");
  });

  it("validates the real top-level Goal acknowledgement and proves status-read progress", () => {
    assertGoalProofResponse({ id: "goal-1", status: "DRAFT", version: 2 }, "goal-1", 1);
    assertGoalStatusProof({ goal: { id: "goal-1", progressPercent: GOAL_PROGRESS, version: 2 } }, "goal-1", GOAL_PROGRESS, 2);
    expect(() => assertGoalProofResponse({ goal: { id: "goal-1", progressPercent: GOAL_PROGRESS, version: 2 } }, "goal-1", 1)).toThrow("GOAL_PROOF_WRITE_UNPROVEN");
    expect(() => assertGoalProofResponse({ id: "goal-1", status: "DRAFT" }, "goal-1", 1)).toThrow("GOAL_PROOF_WRITE_UNPROVEN");
    expect(() => assertGoalProofResponse({ id: "goal-1", status: "PUBLISHED", version: 2 }, "goal-1", 1)).toThrow("GOAL_PROOF_WRITE_UNPROVEN");
    expect(() => assertGoalStatusProof({ goal: { id: "goal-1", progressPercent: GOAL_PROGRESS, version: 3 } }, "goal-1", GOAL_PROGRESS, 2)).toThrow("GOAL_STATUS_PROOF_UNPROVEN");
    expect(() => assertGoalStatusProof({ goal: { id: "goal-1", progressPercent: 99, version: 2 } }, "goal-1", GOAL_PROGRESS, 2)).toThrow("GOAL_STATUS_PROOF_UNPROVEN");
  });

  it("never uses the provisioned credential token as driver authorization", async () => {
    const driver = await readFile(new URL("./pr976-action-goal-production-smoke.mjs", import.meta.url), "utf8");
    expect(driver).toContain("provision.credentialToken");
    expect(driver).not.toMatch(/authorization["']?\s*:/i);
    expect(driver).not.toMatch(/Bearer\s+\$\{?provision\.credentialToken/i);
  });

  it("retries retryable pending terminal cleanup until completed", async () => {
    const harness = terminalHarness([
      retryablePendingReceipt(),
      { receipt: { outcome: "COMPLETED" } },
    ]);
    const result = await terminalizeUntilSettled({
      send: harness.send,
      payload: { operation: "terminalize", mode: "all" },
      deadlineMs: 90_000,
      acceptedOutcomes: ["COMPLETED"],
      now: harness.now,
      sleep: harness.sleep,
    });
    expect(result.receipt.outcome).toBe("COMPLETED");
    expect(harness.calls.map((call) => call.timeoutMs)).toEqual([30_000, 30_000]);
    expect(harness.sleeps).toEqual([500]);
  });

  it("clips retry backoff and request timeouts to remaining terminal cleanup deadline", async () => {
    const harness = terminalHarness([
      retryablePendingReceipt(),
      retryablePendingReceipt(),
      { receipt: { outcome: "COMPLETED" } },
    ]);
    await terminalizeUntilSettled({
      send: harness.send,
      payload: { operation: "terminalize", mode: "all" },
      deadlineMs: 1_600,
      acceptedOutcomes: ["COMPLETED"],
      now: harness.now,
      sleep: harness.sleep,
    });
    expect(harness.calls.map((call) => call.timeoutMs)).toEqual([1_600, 1_100, 100]);
    expect(harness.sleeps).toEqual([500, 1_000]);
  });

  it("stops at the terminal cleanup deadline without a post-deadline call", async () => {
    const harness = terminalHarness([
      retryablePendingReceipt(),
      retryablePendingReceipt(),
      retryablePendingReceipt(),
    ]);
    await expect(terminalizeUntilSettled({
      send: harness.send,
      payload: { operation: "terminalize", mode: "all" },
      deadlineMs: 600,
      acceptedOutcomes: ["COMPLETED"],
      now: harness.now,
      sleep: harness.sleep,
    })).rejects.toMatchObject({
      message: "TERMINAL_CLEANUP_DEADLINE_EXCEEDED",
      body: { lastReceipt: { outcome: "PENDING", failureCode: "RETRYABLE_TARGET_CLEANUP_FAILED" } },
    });
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls.map((call) => call.timeoutMs)).toEqual([600, 100]);
    expect(harness.sleeps).toEqual([500, 100]);
  });

  it("fails terminal cleanup immediately for fatal responses", async () => {
    const httpError = Object.assign(new Error("HTTP_503"), { status: 503 });
    const httpHarness = terminalHarness([httpError]);
    await expect(terminalizeUntilSettled({
      send: httpHarness.send,
      payload: { operation: "terminalize" },
      deadlineMs: 90_000,
      acceptedOutcomes: ["COMPLETED"],
      now: httpHarness.now,
    })).rejects.toThrow("HTTP_503");
    const malformedHarness = terminalHarness([{ ok: true }]);
    await expect(terminalizeUntilSettled({
      send: malformedHarness.send,
      payload: { operation: "terminalize" },
      deadlineMs: 90_000,
      acceptedOutcomes: ["COMPLETED"],
      now: malformedHarness.now,
    })).rejects.toThrow("TERMINAL_RECEIPT_MALFORMED");
    const mismatchHarness = terminalHarness([{ receipt: { outcome: "FAILED" } }]);
    await expect(terminalizeUntilSettled({
      send: mismatchHarness.send,
      payload: { operation: "terminalize" },
      deadlineMs: 90_000,
      acceptedOutcomes: ["COMPLETED"],
      now: mismatchHarness.now,
    })).rejects.toThrow("TERMINAL_RECEIPT_OUTCOME_UNEXPECTED");
    const pendingHarness = terminalHarness([{ receipt: { outcome: "PENDING", failureCode: "PERMANENT_FAILURE" } }]);
    await expect(terminalizeUntilSettled({
      send: pendingHarness.send,
      payload: { operation: "terminalize" },
      deadlineMs: 90_000,
      acceptedOutcomes: ["COMPLETED"],
      now: pendingHarness.now,
    })).rejects.toThrow("TERMINAL_RECEIPT_PENDING_NOT_RETRYABLE");
  });

  it("resends sanitized failure cleanup payload on every retry and accepts failed or blocked", async () => {
    const payload = {
      operation: "terminalize",
      mode: "all",
      failureCode: "DRIVER_FAILURE",
      failureMessage: sanitize("failed with token raw-secret"),
    };
    for (const outcome of ["FAILED", "BLOCKED"]) {
      const harness = terminalHarness([
        retryablePendingReceipt(),
        { receipt: { outcome } },
      ]);
      await expect(terminalizeUntilSettled({
        send: harness.send,
        payload,
        deadlineMs: 90_000,
        acceptedOutcomes: ["FAILED", "BLOCKED"],
        now: harness.now,
        sleep: harness.sleep,
      })).resolves.toMatchObject({ receipt: { outcome } });
      expect(harness.calls.map((call) => call.payload)).toEqual([payload, payload]);
      expect(JSON.stringify(harness.calls)).not.toContain("raw-secret");
    }
  });

  it("keeps one terminal cleanup deadline for normal terminalization and catch recovery", async () => {
    const driver = await readFile(new URL("./pr976-action-goal-production-smoke.mjs", import.meta.url), "utf8");
    expect(driver.match(/Date\.now\(\) \+ TERMINAL_CLEANUP_DEADLINE_MS/g)).toHaveLength(1);
    expect(driver).toContain("terminalCleanupDeadline ??=");
    expect(driver.match(/deadlineMs: terminalDeadline\(\)/g)).toHaveLength(2);
  });
});

describe("pr976 action/goal production smoke workflow", () => {
  it("is manual, protected, main-only, minimally permissioned, and fixed-input", async () => {
    const workflow = await readFile(new URL("../workflows/pr976-action-goal-production-smoke.yml", import.meta.url), "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/schedule:|workflow_run:|pull_request:/);
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("actions: read");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("expected_deployed_sha");
    expect(workflow).not.toContain("PRODUCTION_DATABASE_URL");
  });

  it("keeps the static receipt cleanup guard inventory", async () => {
    const migration = await readFile(new URL("../../prisma/migrations/20260825070000_pr976_production_validation_receipt/migration.sql", import.meta.url), "utf8");
    const guards = [
      "ProductionValidationReceipt_action_checklist_cleanup_guard",
      "ProductionValidationReceipt_action_evidence_cleanup_guard",
      "ProductionValidationReceipt_action_external_attachment_cleanup_guard",
      "ProductionValidationReceipt_action_deliberation_cleanup_guard",
      "ProductionValidationReceipt_action_advice_process_cleanup_guard",
      "ProductionValidationReceipt_goal_parent_cleanup_guard",
      "ProductionValidationReceipt_goal_key_result_cleanup_guard",
      "ProductionValidationReceipt_goal_update_cleanup_guard",
      "ProductionValidationReceipt_goal_link_cleanup_guard",
      "ProductionValidationReceipt_goal_recognition_cleanup_guard",
      "ProductionValidationReceipt_agent_identity_cleanup_guard",
      "ProductionValidationReceipt_agent_credential_cleanup_guard",
    ];
    for (const guard of guards) {
      expect(migration).toContain(`CREATE TRIGGER "${guard}"`);
    }
    expect(migration.match(/CREATE TRIGGER "ProductionValidationReceipt_/g)).toHaveLength(guards.length);
    expect(migration.match(/pg_advisory_xact_lock\(hashtext\('work_item_version'\)/g)).toHaveLength(2);
    expect(migration.match(/pg_advisory_xact_lock\(hashtext\('production_validation_credential'\)/g)).toHaveLength(4);
  });
});
