import { describe, expect, it, vi } from "vitest";
import {
  assertManagedAzureRevisionProjection, assertManagedAzureTemplateDelta,
  buildManagedAzureReleaseTemplate, createManagedAzureContainerAppTransport, managedAzureRevisionSuffix,
} from "./managed-azure-container-app-transport.mjs";

const target = { subscriptionId: "123e4567-e89b-42d3-a456-426614174000", resourceGroup: "rg-test",
  acrName: "acrtest", acrServer: "acrtest.azurecr.io", webAppName: "web-app", workerAppName: "worker-app" };
const release = { gitSha: "b".repeat(40), imageTag: `sha-${"b".repeat(40)}`, version: "next" };
const image = `acrtest.azurecr.io/corgtex/web@sha256:${"2".repeat(64)}`;
function template(role = "web") {
  return { revisionSuffix: "old", containers: [{ name: role, image: `acrtest.azurecr.io/corgtex/${role}@sha256:${"1".repeat(64)}`,
    env: [{ name: "CORGTEX_STARTUP_MODE", value: role },
      { name: "CORGTEX_RELEASE_GIT_SHA", value: "a".repeat(40) },
      { name: "CORGTEX_RELEASE_IMAGE_TAG", value: `sha-${"a".repeat(40)}` },
      { name: "CORGTEX_RELEASE_VERSION", value: "old" }, { name: "PRIVATE_SETTING", secretRef: "private-ref" }],
    resources: { cpu: 0.5, memory: "1Gi", ephemeralStorage: "2Gi" } }],
    scale: { minReplicas: 1, maxReplicas: 3, cooldownPeriod: 300, pollingInterval: 30 } };
}
function revisionProjection(candidate) {
  const value = structuredClone(candidate);
  delete value.revisionSuffix;
  delete value.containers[0].resources.ephemeralStorage;
  value.containers[0].probes = [];
  delete value.scale.cooldownPeriod;
  delete value.scale.pollingInterval;
  return value;
}

describe("managed web migration startup", () => {
  it.each(["web", "migrate-and-web"])("allows only the startup delta from %s while preserving all other settings", (mode) => {
    const original = template(); original.containers[0].env[0].value = mode;
    const baseline = { role: "web", template: original };
    const expected = { role: "web", image, release, revisionSuffix: "new", migrateWeb: true };
    const candidate = buildManagedAzureReleaseTemplate({ baseline, ...expected });
    expect(candidate.containers[0].env[0].value).toBe("migrate-and-web");
    expect(assertManagedAzureTemplateDelta(baseline, candidate, expected)).toBe(true);
    const reconstructed = structuredClone(candidate);
    reconstructed.revisionSuffix = original.revisionSuffix;
    reconstructed.containers[0].image = original.containers[0].image;
    reconstructed.containers[0].env = structuredClone(original.containers[0].env);
    expect(reconstructed).toEqual(original);
    expect(original.containers[0].env[0].value).toBe(mode);
    candidate.scale.maxReplicas += 1;
    expect(() => assertManagedAzureTemplateDelta(baseline, candidate, expected)).toThrow("AZURE_TEMPLATE_DRIFT");
  });
  it.each([undefined, "combined", "migrate-and-seed", "worker"])("rejects unsafe or missing web mode %s", (mode) => {
    const value = template();
    if (mode === undefined) value.containers[0].env.shift(); else value.containers[0].env[0].value = mode;
    expect(() => buildManagedAzureReleaseTemplate({ baseline: { role: "web", template: value }, role: "web", image, release,
      revisionSuffix: "new", migrateWeb: true })).toThrow("AZURE_STARTUP_MODE_INVALID");
  });
  it("does not change worker startup, command, arguments, resources or secret references", () => {
    const original = template("worker");
    original.containers[0].command = ["npm"]; original.containers[0].args = ["run", "worker"];
    const args = { baseline: { role: "worker", template: original }, role: "worker", image: image.replace("/web@", "/worker@"), release, revisionSuffix: "new" };
    expect(buildManagedAzureReleaseTemplate({ ...args, migrateWeb: true })).toEqual(buildManagedAzureReleaseTemplate(args));
  });
  it("permits only generation two of web rollback and never generation three", () => {
    const args = { leaseId: "123e4567-e89b-42d3-a456-426614174000", fence: 7, role: "web", phase: "rollback" };
    expect(managedAzureRevisionSuffix({ ...args, generation: 2 })).toBe(`${managedAzureRevisionSuffix(args)}-2`);
    for (const extra of [{ generation: 3 }, { generation: 2, role: "worker" }, { generation: 2, phase: "forward" }]) {
      expect(() => managedAzureRevisionSuffix({ ...args, ...extra })).toThrow("AZURE_REVISION_SUFFIX_INVALID");
    }
  });
});

describe("exact immutable revision projection", () => {
  it("accepts only observed default omissions without changing the canonical template", () => {
    const expected = template(); const before = structuredClone(expected);
    expect(assertManagedAzureRevisionProjection(expected, revisionProjection(expected), "web-app", "web-app--old")).toBe(true);
    expect(expected).toEqual(before);
  });
  it.each(["", "old"])("accepts explicit null projections with exact revision-name proof for suffix %s", (suffix) => {
    const expected = template(); expected.revisionSuffix = suffix;
    const actual = revisionProjection(expected);
    actual.revisionSuffix = null;
    actual.containers[0].resources.ephemeralStorage = null;
    actual.containers[0].probes = null;
    actual.scale.cooldownPeriod = null;
    actual.scale.pollingInterval = null;
    expect(assertManagedAzureRevisionProjection(expected, actual, "web-app", suffix ? "web-app--old" : "web-app--0000001")).toBe(true);
    expect(() => assertManagedAzureRevisionProjection(expected, actual, "web-app", "other-app--old")).toThrow("AZURE_REVISION_TEMPLATE_DRIFT");
    if (suffix) expect(() => assertManagedAzureRevisionProjection(expected, actual, "web-app", "web-app--different")).toThrow("AZURE_REVISION_TEMPLATE_DRIFT");
  });
  it.each(["image", "startup", "secret", "resource", "scale", "probes", "extra", "suffix", "imageType"])("rejects %s drift outside the projection allowlist", (change) => {
    const expected = template(); const revision = revisionProjection(expected);
    if (change === "image") revision.containers[0].image = image;
    if (change === "startup") revision.containers[0].env[0].value = "combined";
    if (change === "secret") revision.containers[0].env.at(-1).secretRef = "other-ref";
    if (change === "resource") expected.containers[0].resources.ephemeralStorage = "4Gi";
    if (change === "scale") expected.scale.cooldownPeriod = 301;
    if (change === "probes") revision.containers[0].probes = [{ type: "Liveness" }];
    if (change === "extra") revision.extra = true;
    if (change === "suffix") revision.revisionSuffix = "other";
    if (change === "imageType") revision.containers[0].imageType = null;
    expect(() => assertManagedAzureRevisionProjection(expected, revision, "web-app", "web-app--old")).toThrow("AZURE_REVISION_TEMPLATE_DRIFT");
  });
  it.each(["READY", "FAILED", "PROVISIONING", "UNKNOWN"])("retains actual %s health separately from template identity", async (kind) => {
    const expected = template();
    const properties = { template: revisionProjection(expected), active: true, provisioningState: "Provisioned",
      healthState: kind === "READY" ? "Healthy" : "None", runningState: kind === "READY" ? "Running" : kind === "FAILED" ? "ActivationFailed" : kind === "PROVISIONING" ? "Activating" : "Unknown" };
    const fetchImpl = vi.fn(async (url) => String(url).includes("/replicas?") ? Response.json({ value: [{ properties: {
      runningState: kind === "READY" ? "Running" : "NotRunning", containers: [{ name: "web", ready: kind === "READY" }],
    } }] }) : Response.json({ name: "web-app--old", properties }));
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: async () => "synthetic-token" });
    expect(await transport.readRevisionState({ target, role: "web", revisionName: "web-app--old", expectedTemplate: expected })).toEqual({ kind });
    expect(fetchImpl.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });
  it("does not mistake a healthy revision with an unready replica for ready", async () => {
    const expected = template();
    const fetchImpl = vi.fn(async (url) => String(url).includes("/replicas?") ? Response.json({ value: [{ properties: {
      runningState: "Running", containers: [{ name: "web", ready: false }],
    } }] }) : Response.json({ name: "web-app--old", properties: { template: revisionProjection(expected), active: true,
      provisioningState: "Provisioned", healthState: "Healthy", runningState: "Running" } }));
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: async () => "synthetic-token" });
    expect((await transport.readRevisionState({ target, role: "web", revisionName: "web-app--old", expectedTemplate: expected })).kind).not.toBe("READY");
  });
});
