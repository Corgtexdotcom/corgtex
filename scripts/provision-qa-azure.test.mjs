import { describe, expect, it } from "vitest";
import { assertServingRelease, executionTemplate } from "./provision-qa-azure.mjs";

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
