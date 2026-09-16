import { describe, expect, it } from "vitest";
import { assertServingRelease, executionTemplate, isTerminalExecution } from "./provision-qa-azure.mjs";

const sha = "a".repeat(40);
const image = `acrcorgtexssstgwus3.azurecr.io/corgtex/web@sha256:${"b".repeat(64)}`;
const source = { containers: [{ name: "web", image: "old", command: ["sh"], env: [{ name: "CLIENT_API_KEY", value: "must-not-inherit" }], resources: { cpu: 1, memory: "2Gi" } }] };

it("uses an execution-only override and does not inherit client/provider secrets", () => {
  const result = executionTemplate(source, image, sha, "apply", { QA_EXPECTED_DEMO_WORKSPACE_ID: "demo-id" });
  expect(source.containers[0].image).toBe("old");
  expect(result.containers[0]).toMatchObject({ image, command: ["node"], args: ["scripts/provision-qa-workspaces.mjs", "--apply"] });
  expect(result.containers[0].env).not.toContainEqual({ name: "CLIENT_API_KEY", value: "must-not-inherit" });
  expect(result.containers[0].env).toContainEqual({ name: "ADMIN_PASSWORD", secretRef: "qa-validation-admin-password" });
  expect(result.containers[0].env).toContainEqual({ name: "QA_EXPECTED_DEMO_WORKSPACE_ID", value: "demo-id" });
});

it("preflight does not need QA account secrets or mutate fixtures", () => {
  const result = executionTemplate(source, image, sha, "preflight", {});
  expect(result.containers[0].args).toEqual(["scripts/provision-qa-workspaces.mjs"]);
  expect(result.containers[0].env.some((item) => item.name === "ADMIN_PASSWORD")).toBe(false);
});

it("refuses other registry images and unexpected job init containers", () => {
  expect(() => executionTemplate(source, "other.azurecr.io/web:latest", sha, "apply", {})).toThrow("immutable");
  expect(() => executionTemplate({ ...source, initContainers: [{}] }, image, sha, "apply", {})).toThrow("Unexpected");
});

describe("serving release proof", () => {
  const web = { properties: { template: { containers: [{ image: `acrcorgtexssstgwus3.azurecr.io/corgtex/web:sha-${sha}` }] }, configuration: { ingress: { customDomains: [{ name: "selfserve.corgtex.com" }] } } } };
  const health = { status: "ok", database: "up", runtime: { workspaceScopeValid: true, workspaceScopeSlug: null }, release: { gitSha: sha, drift: { gitSha: false } } };
  it("accepts the verified selfserve image and matching health version", () => {
    expect(() => assertServingRelease(web, health, sha, image)).not.toThrow();
  });
  it.each([{ ...health, status: "degraded" }, { ...health, release: { gitSha: "c".repeat(40) } }, { ...health, release: { gitSha: sha, drift: { gitSha: true } } }])("refuses unhealthy, mismatched, or drifted release proof", (bad) => {
    expect(() => assertServingRelease(web, bad, sha, image)).toThrow("expected serving release");
  });
});

it("treats canceled jobs as terminal without treating active jobs as settled", () => {
  expect(isTerminalExecution("Canceled")).toBe(true);
  expect(isTerminalExecution("Running")).toBe(false);
});

const adoptionEnv = {
  QA_OPERATION: "adopt-validation-owner", QA_EXPECTED_VALIDATION_WORKSPACE_ID: "validation-id", QA_EXPECTED_VALIDATION_ADMIN_USER_ID: "seed-admin-id",
  QA_EXECUTION_ACTOR: "rerun-operator", QA_EXECUTION_INITIATOR: "original-operator", QA_EXECUTION_REPOSITORY: "Corgtexdotcom/corgtex",
  QA_EXECUTION_RUN_ID: "123", QA_EXECUTION_RUN_ATTEMPT: "2", QA_EXECUTION_WORKFLOW_REF: "Corgtexdotcom/corgtex/.github/workflows/qa-workspaces.yml@refs/heads/main",
};

it.each(["preflight", "apply"])("owner adoption %s never runs fixture seeds or passes passwords", mode => {
  const result = executionTemplate(source, image, sha, mode, adoptionEnv).containers[0];
  expect(result.args).toEqual(["scripts/adopt-validation-support-owner.mjs", ...(mode === "apply" ? ["--apply"] : [])]);
  expect(result.env.filter(item => item.secretRef)).toEqual([{ name: "DATABASE_URL", secretRef: "database-url" }]);
  expect(result.env).toContainEqual({ name: "VALIDATION_BOOTSTRAP_ADMIN_EMAIL", value: "qa-validation-admin@corgtex.test" });
  expect(result.env).toContainEqual({ name: "QA_EXPECTED_VALIDATION_ADMIN_USER_ID", value: "seed-admin-id" });
  expect(result.env.some(item => item.name === "QA_EXPECTED_DEMO_WORKSPACE_ID")).toBe(false);
  if (mode === "apply") expect(result.env).toContainEqual({ name: "QA_EXECUTION_ACTOR", value: "rerun-operator" });
});

it("allows owner preflight without reviewed IDs but refuses apply without them", () => {
  expect(executionTemplate(source, image, sha, "preflight", { QA_OPERATION: "adopt-validation-owner" }).containers[0].args).toEqual(["scripts/adopt-validation-support-owner.mjs"]);
  for (const field of ["QA_EXPECTED_VALIDATION_WORKSPACE_ID", "QA_EXPECTED_VALIDATION_ADMIN_USER_ID"]) {
    expect(() => executionTemplate(source, image, sha, "apply", { ...adoptionEnv, [field]: undefined })).toThrow("reviewed");
  }
  expect(() => executionTemplate(source, image, sha, "apply", { ...adoptionEnv, QA_EXECUTION_ACTOR: undefined })).toThrow("QA_EXECUTION_ACTOR");
  expect(() => executionTemplate(source, image, sha, "apply", { QA_OPERATION: "customer-owner" })).toThrow("Invalid QA operation");
});
