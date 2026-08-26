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
  expectConflict,
  expectMcpConflict,
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
      drift: { gitSha: false, imageTag: false, version: false },
    }, expected)).not.toThrow();
    expect(() => assertReleaseRuntime({
      gitSha: expected,
      runtime: { gitSha: "2".repeat(40), source: "container" },
      drift: { gitSha: false, imageTag: false, version: false },
    }, expected)).toThrow("SERVING_RUNTIME_SHA_MISMATCH");
    expect(() => assertReleaseRuntime({
      gitSha: expected,
      runtime: { gitSha: expected },
      drift: { gitSha: false, imageTag: false, version: false },
    }, expected)).toThrow("SERVING_RUNTIME_SOURCE_MISSING");
    expect(() => assertReleaseRuntime({
      gitSha: expected,
      runtime: { gitSha: expected, source: "container" },
      drift: { gitSha: true, imageTag: false, version: false },
    }, expected)).toThrow("SERVING_RELEASE_DRIFT");
  });

  it("fails closed when PR 976 file equality drifts", () => {
    expect(() => verifyGitLineage("0000000000000000000000000000000000000000")).toThrow(/Command failed/);
  });

  it("requires an exact HTTP stale-write conflict envelope", () => {
    expect(() => expectConflict({ status: 409, body: { error: { code: "VERSION_CONFLICT" } } })).not.toThrow();
    expect(() => expectConflict({ status: 409, body: { error: { code: "NOT_VERSION_CONFLICT" } } })).toThrow();
    expect(() => expectConflict({ status: 400, body: { error: { code: "VERSION_CONFLICT" } } })).toThrow();
    expect(() => expectConflict({ status: 409, body: { code: "VERSION_CONFLICT" } })).toThrow();
  });

  it("requires an exact MCP stale-write status", () => {
    expect(() => expectMcpConflict({ status: "VERSION_CONFLICT" })).not.toThrow();
    expect(() => expectMcpConflict({ status: "NOT_VERSION_CONFLICT" })).toThrow("MCP_VERSION_CONFLICT_NOT_RETURNED");
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
      "ProductionValidationReceipt_goal_parent_cleanup_guard",
      "ProductionValidationReceipt_goal_key_result_cleanup_guard",
      "ProductionValidationReceipt_goal_update_cleanup_guard",
      "ProductionValidationReceipt_goal_link_cleanup_guard",
      "ProductionValidationReceipt_goal_recognition_cleanup_guard",
      "ProductionValidationReceipt_agent_identity_cleanup_guard",
    ];
    for (const guard of guards) {
      expect(migration).toContain(`CREATE TRIGGER "${guard}"`);
    }
    expect(migration.match(/CREATE TRIGGER "ProductionValidationReceipt_/g)).toHaveLength(guards.length);
    expect(migration.match(/pg_advisory_xact_lock\(hashtext\('work_item_version'\)/g)).toHaveLength(2);
    expect(migration.match(/pg_advisory_xact_lock\(hashtext\('production_validation_credential'\)/g)).toHaveLength(1);
  });
});
