import { describe, expect, it } from "vitest";
import {
  assertManagedAzureTemplateDelta,
  buildManagedAzureReleaseTemplate,
} from "./managed-azure-container-app-transport.mjs";

const baseSha = "a".repeat(40);
const oldRuntimeSha = "b".repeat(40);
const nextSha = "c".repeat(40);
const targetServer = "acrtest.azurecr.io";
const release = Object.freeze({
  gitSha: nextSha,
  imageTag: `sha-${nextSha}`,
  version: "release-next",
});
const image = `${targetServer}/corgtex/web@sha256:${"1".repeat(64)}`;
const expected = Object.freeze({
  role: "web",
  image,
  release,
  revisionSuffix: "next",
});

function template(env = []) {
  return {
    revisionSuffix: "base",
    containers: [{
      name: "web",
      image: `${targetServer}/corgtex/web@sha256:${"0".repeat(64)}`,
      env: [
        { name: "CORGTEX_STARTUP_MODE", value: "web" },
        { name: "DATABASE_URL", secretRef: "database-url" },
        { name: "CORGTEX_RELEASE_GIT_SHA", value: baseSha },
        { name: "CORGTEX_RELEASE_IMAGE_TAG", value: `sha-${baseSha}` },
        { name: "CORGTEX_RELEASE_VERSION", value: "release-base" },
        ...env,
      ],
      resources: { cpu: 1, memory: "2Gi" },
    }],
    scale: { minReplicas: 1, maxReplicas: 2 },
  };
}

function baseline(env = []) {
  return { role: "web", template: template(env) };
}

function envEntry(candidate, name) {
  return candidate.containers[0].env.find((entry) => entry.name === name);
}

describe("managed Azure release runtime identity", () => {
  it("rewrites an existing literal GITHUB_SHA to the selected release for new writes", () => {
    const candidate = buildManagedAzureReleaseTemplate({
      baseline: baseline([{ name: "GITHUB_SHA", value: oldRuntimeSha }]),
      ...expected,
    });

    expect(envEntry(candidate, "GITHUB_SHA")).toStrictEqual({ name: "GITHUB_SHA", value: nextSha });
    expect(envEntry(candidate, "CORGTEX_RELEASE_GIT_SHA")).toStrictEqual({ name: "CORGTEX_RELEASE_GIT_SHA", value: nextSha });
    expect(assertManagedAzureTemplateDelta(baseline([{ name: "GITHUB_SHA", value: oldRuntimeSha }]), candidate, expected)).toBe(true);
  });

  it("keeps GITHUB_SHA absent when the baseline does not carry one", () => {
    const candidate = buildManagedAzureReleaseTemplate({ baseline: baseline(), ...expected });

    expect(envEntry(candidate, "GITHUB_SHA")).toBeUndefined();
    expect(candidate.containers[0].env.map((entry) => entry.name)).toStrictEqual([
      "CORGTEX_STARTUP_MODE",
      "DATABASE_URL",
      "CORGTEX_RELEASE_GIT_SHA",
      "CORGTEX_RELEASE_IMAGE_TAG",
      "CORGTEX_RELEASE_VERSION",
    ]);
    expect(assertManagedAzureTemplateDelta(baseline(), candidate, expected)).toBe(true);
  });

  it("rejects nonliteral, malformed, and duplicate GITHUB_SHA entries", () => {
    const rows = [
      { name: "secret-ref", env: [{ name: "GITHUB_SHA", secretRef: "github-sha" }] },
      { name: "missing-value", env: [{ name: "GITHUB_SHA" }] },
      { name: "non-string-value", env: [{ name: "GITHUB_SHA", value: 7 }] },
      { name: "coercible-array-value", env: [{ name: "GITHUB_SHA", value: [oldRuntimeSha] }] },
      { name: "uppercase-value", env: [{ name: "GITHUB_SHA", value: "A".repeat(40) }] },
      { name: "short-value", env: [{ name: "GITHUB_SHA", value: "a".repeat(39) }] },
      { name: "extra-key", env: [{ name: "GITHUB_SHA", value: oldRuntimeSha, secretRef: "shadow" }] },
      { name: "duplicate", env: [{ name: "GITHUB_SHA", value: oldRuntimeSha }, { name: "GITHUB_SHA", value: nextSha }] },
    ];

    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
    for (const row of rows) {
      expect(() => buildManagedAzureReleaseTemplate({ baseline: baseline(row.env), ...expected })).toThrow("AZURE_TEMPLATE_INVALID");
    }
  });

  it("preserves a valid literal GITHUB_SHA only for historical reconstruction", () => {
    const args = {
      baseline: baseline([{ name: "GITHUB_SHA", value: oldRuntimeSha }]),
      ...expected,
      preserveRuntimeIdentity: true,
    };
    const candidate = buildManagedAzureReleaseTemplate(args);

    expect(envEntry(candidate, "GITHUB_SHA")).toStrictEqual({ name: "GITHUB_SHA", value: oldRuntimeSha });
    expect(envEntry(candidate, "CORGTEX_RELEASE_GIT_SHA")).toStrictEqual({ name: "CORGTEX_RELEASE_GIT_SHA", value: nextSha });
    expect(assertManagedAzureTemplateDelta(args.baseline, candidate, {
      ...expected,
      preserveRuntimeIdentity: true,
    })).toBe(true);
    expect(() => buildManagedAzureReleaseTemplate({
      ...args,
      baseline: baseline([{ name: "GITHUB_SHA", value: "bad-sha" }]),
    })).toThrow("AZURE_TEMPLATE_INVALID");
  });

  it("detects unexpected environment edits in the exact template delta", () => {
    const source = baseline([{ name: "GITHUB_SHA", value: oldRuntimeSha }]);
    const candidate = buildManagedAzureReleaseTemplate({ baseline: source, ...expected });
    envEntry(candidate, "CORGTEX_STARTUP_MODE").value = "worker";

    expect(() => assertManagedAzureTemplateDelta(source, candidate, expected)).toThrow("AZURE_TEMPLATE_DRIFT");
  });
});
