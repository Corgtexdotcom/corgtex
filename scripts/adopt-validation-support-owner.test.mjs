import { describe, expect, it } from "vitest";
import { adoptionConfig } from "./adopt-validation-support-owner.mjs";

const sha = "a".repeat(40);
const build = { role: "web", gitSha: sha };
const env = {
  DATABASE_URL: "postgresql://synthetic@127.0.0.1/corgtex_test?schema=public",
  QA_EXPECTED_DATABASE_HOST: "127.0.0.1", QA_EXPECTED_DATABASE_NAME: "corgtex_test", QA_EXPECTED_DATABASE_SCHEMA: "public",
  QA_EXPECTED_RELEASE_SHA: sha, VALIDATION_BOOTSTRAP_ADMIN_EMAIL: "  Dedicated-Seed@validation.invalid ",
  QA_EXPECTED_VALIDATION_WORKSPACE_ID: "validation-id", QA_EXPECTED_VALIDATION_ADMIN_USER_ID: "seed-admin-id",
  QA_EXECUTION_ACTOR: "operator-rerunning-job", QA_EXECUTION_INITIATOR: "initial-dispatcher",
  QA_EXECUTION_REPOSITORY: "Corgtexdotcom/corgtex", QA_EXECUTION_RUN_ID: "123", QA_EXECUTION_RUN_ATTEMPT: "2",
  QA_EXECUTION_WORKFLOW_REF: "Corgtexdotcom/corgtex/.github/workflows/qa-workspaces.yml@refs/heads/main",
};

it("defaults to read-only inventory with explicit configured email and no guessed IDs", () => {
  const config = adoptionConfig({ ...env, QA_EXPECTED_VALIDATION_WORKSPACE_ID: undefined, QA_EXPECTED_VALIDATION_ADMIN_USER_ID: undefined }, [], build);
  expect(config).toMatchObject({ apply: false, adminEmail: "dedicated-seed@validation.invalid", expectedWorkspaceId: null, expectedAdminUserId: null, execution: null });
});

it("records the real job actor separately from the proposed owner and initial dispatcher", () => {
  expect(adoptionConfig(env, ["--apply"], build).execution).toMatchObject({ kind: "github-actions", actor: "operator-rerunning-job", initiator: "initial-dispatcher", runId: "123", runAttempt: "2", releaseSha: sha });
});

it.each(["QA_EXPECTED_VALIDATION_WORKSPACE_ID", "QA_EXPECTED_VALIDATION_ADMIN_USER_ID", "QA_EXECUTION_ACTOR", "QA_EXECUTION_RUN_ID", "QA_EXECUTION_WORKFLOW_REF"])("apply rejects missing %s", name => {
  expect(() => adoptionConfig({ ...env, [name]: undefined }, ["--apply"], build)).toThrow(name);
});

it("never falls back to ADMIN_EMAIL or creates a guessed support account", () => {
  expect(() => adoptionConfig({ ...env, VALIDATION_BOOTSTRAP_ADMIN_EMAIL: undefined, ADMIN_EMAIL: "admin@validation.invalid" }, [], build)).toThrow("VALIDATION_BOOTSTRAP_ADMIN_EMAIL");
});

describe("target and invocation fences", () => {
  it.each([
    { QA_EXPECTED_DATABASE_HOST: "another-host" }, { QA_EXPECTED_DATABASE_NAME: "other" }, { QA_EXPECTED_DATABASE_SCHEMA: "private" },
  ])("rejects target mismatch %j before connecting", overrides => {
    expect(() => adoptionConfig({ ...env, ...overrides }, [], build)).toThrow("Confirmed database");
  });
  it.each([{ role: "worker", gitSha: sha }, { role: "web", gitSha: "b".repeat(40) }])("rejects incorrect image metadata %j", imageBuild => {
    expect(() => adoptionConfig(env, [], imageBuild)).toThrow("expected web release");
  });
  it.each([["--force"], ["--apply", "--apply"], ["--workspace", "customer"]])("rejects alternate scope/bypass arguments %j", (...argv) => {
    expect(() => adoptionConfig(env, argv, build)).toThrow("Use no arguments");
  });
  it.each([{ QA_EXECUTION_REPOSITORY: "other/repo" }, { QA_EXECUTION_RUN_ID: "not-a-run" }, { QA_EXECUTION_WORKFLOW_REF: env.QA_EXECUTION_WORKFLOW_REF.replace("main", "unreviewed") }])("rejects unprotected execution provenance %j", overrides => {
    expect(() => adoptionConfig({ ...env, ...overrides }, ["--apply"], build)).toThrow("protected QA workflow");
  });
});
