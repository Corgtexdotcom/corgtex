import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import * as releaseModule from "./azure-release-managed-target.mjs";
const SHA = "a".repeat(40); const WEB_DIGEST = `sha256:${"b".repeat(64)}`;
const WORKER_DIGEST = `sha256:${"c".repeat(64)}`; const DEPLOYMENT_ID = "aaaaaaaa-aaaa-faaa-0aaa-aaaaaaaa0101";
const target = {
  deploymentId: DEPLOYMENT_ID, deploymentKind: "REMOTE_MANAGED", cloudProvider: "AZURE", environment: "production",
  deploymentStatus: "ACTIVE", provisioningStatus: "active", releaseEligible: true, provider: "azure",
  group: "managed-customers", workload: "managed-customers",
  azure: { subscriptionId: "bbbbbbbb-bbbb-0bbb-fbbb-bbbbbbbb0102", resourceGroup: "rg-managed",
    acrName: "acrmanaged", acrServer: "acrmanaged.azurecr.io", webAppName: "managed-web", workerAppName: "managed-worker" },
};
function input() {
  return { deploymentId: DEPLOYMENT_ID, deployments: [structuredClone(target)], gitSha: SHA,
    manifests: {
      web: { sourceTag: `ghcr.io/corgtexdotcom/corgtex/web:sha-${SHA}`, raw: JSON.stringify({ mediaType: "application/test", digest: WEB_DIGEST, credential: "private-credential-canary" }) },
      worker: { sourceTag: `ghcr.io/corgtexdotcom/corgtex/worker:sha-${SHA}`, raw: JSON.stringify({ digest: WORKER_DIGEST }) },
    } };
}
function expectInvalid(operation, canary = "private-credential-canary") {
  try { operation(); expect.unreachable(); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("MANAGED_AZURE_RELEASE_INPUT_INVALID");
    expect(error.message).not.toContain(canary);
  }
}
describe("managed Azure release intent primitives", () => {
  test("exports only the four fixed functions and stays inert", () => {
    expect(Object.keys(releaseModule).sort()).toStrictEqual([
      "canonicalizeManagedAzureImportRequestV1", "canonicalizeManagedAzureImportRequestValueV1",
      "canonicalizeManagedAzureReleaseIntentV1", "compareManagedAzureDestinationDigestV1",
    ]);
    const source = readFileSync(new URL("./azure-release-managed-target.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:fs|node:child_process|node:http|node:https|\bfetch\b|\beval\b|\bFunction\b|\brequire\s*\(|process\.|console\.|setTimeout|setInterval|Math\.random|Date\.|import\s*\(/);
  });
  test("builds fresh exact frozen intent and role requests", () => {
    const firstInput = input(); const intent = releaseModule.canonicalizeManagedAzureReleaseIntentV1(firstInput);
    expect(Object.keys(intent)).toStrictEqual(["schemaVersion", "deploymentId", "target", "gitSha", "imageTag", "roles"]);
    expect(Object.keys(intent.target)).toStrictEqual(["subscriptionId", "resourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"]);
    expect(Object.keys(intent.roles)).toStrictEqual(["web", "worker"]);
    expect(Object.keys(intent.roles.web)).toStrictEqual(["role", "sourceTag", "sourceDigest", "sourceDigestRef", "destinationRepository", "destinationTag"]);
    expect(intent.roles.web).toStrictEqual({ role: "web", sourceTag: firstInput.manifests.web.sourceTag, sourceDigest: WEB_DIGEST,
      sourceDigestRef: `ghcr.io/corgtexdotcom/corgtex/web@${WEB_DIGEST}`, destinationRepository: "corgtex/web", destinationTag: `corgtex/web:sha-${SHA}` });
    expect(intent.roles.worker.sourceDigest).toBe(WORKER_DIGEST);
    expect(Object.isFrozen(intent)).toBe(true); expect(Object.isFrozen(intent.target)).toBe(true);
    expect(Object.isFrozen(intent.roles.web)).toBe(true); expect(JSON.stringify(intent)).not.toContain("private-credential-canary");
    firstInput.deployments[0].azure.acrName = "mutated";
    firstInput.manifests.web.raw = "mutated";
    expect(intent.target.acrName).toBe("acrmanaged");
    expect(intent.roles.web.sourceDigest).toBe(WEB_DIGEST);
    for (const role of ["web", "worker"]) {
      const request = releaseModule.canonicalizeManagedAzureImportRequestV1({ intent, role });
      expect(Object.keys(request)).toStrictEqual(["schemaVersion", "deploymentId", "target", "binding", "mode"]);
      expect(request.binding.role).toBe(role);
      expect(request.mode).toBe("NoForce");
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.binding)).toBe(true);
      const copy = releaseModule.canonicalizeManagedAzureImportRequestValueV1(structuredClone(request));
      expect(copy).toStrictEqual(request);
      expect(copy).not.toBe(request);
      expect(copy.target).not.toBe(request.target);
    }
  });
  test("accepts null-prototype records and opposite caller key order", () => {
    const ordinary = input(); const nullRoot = Object.assign(Object.create(null), ordinary);
    const intent = releaseModule.canonicalizeManagedAzureReleaseIntentV1(nullRoot);
    const reversed = Object.fromEntries(Object.entries(intent).reverse());
    reversed.target = Object.fromEntries(Object.entries(reversed.target).reverse());
    reversed.roles = Object.fromEntries(Object.entries(reversed.roles).reverse());
    reversed.roles.web = Object.fromEntries(Object.entries(reversed.roles.web).reverse());
    reversed.roles.worker = Object.fromEntries(Object.entries(reversed.roles.worker).reverse());
    const request = releaseModule.canonicalizeManagedAzureImportRequestV1({ intent: reversed, role: "web" });
    expect(request.binding.sourceDigest).toBe(WEB_DIGEST);
  });
  test("rejects ambiguous selection and every managed eligibility drift", () => {
    const duplicate = input(); duplicate.deployments.push(structuredClone(target));
    expectInvalid(() => releaseModule.canonicalizeManagedAzureReleaseIntentV1(duplicate));
    const missing = input(); missing.deploymentId = "00000000-0000-4000-8000-000000000199";
    expectInvalid(() => releaseModule.canonicalizeManagedAzureReleaseIntentV1(missing));
    const alias = input(); const sibling = structuredClone(target); sibling.deploymentId = "00000000-0000-4000-8000-000000000199"; sibling.azure.resourceGroup = "RG-MANAGED";
    sibling.azure.webAppName = target.azure.workerAppName; sibling.azure.workerAppName = "managed-other"; alias.deployments.push(sibling);
    expectInvalid(() => releaseModule.canonicalizeManagedAzureReleaseIntentV1(alias));
    sibling.azure.webAppName = "other-web"; sibling.azure.workerAppName = "other-worker"; expect(releaseModule.canonicalizeManagedAzureReleaseIntentV1(alias).deploymentId).toBe(DEPLOYMENT_ID);
    delete sibling.azure.workerAppName; let getterReads = 0; let inheritedResult;
    Object.defineProperty(Object.prototype, "workerAppName", { configurable: true, get() { getterReads += 1; throw new Error("private-credential-canary"); } });
    try { inheritedResult = releaseModule.canonicalizeManagedAzureReleaseIntentV1(alias); } finally { delete Object.prototype.workerAppName; }
    expect(inheritedResult.deploymentId).toBe(DEPLOYMENT_ID); expect(getterReads).toBe(0);
    for (const deploymentId of [DEPLOYMENT_ID.toUpperCase(), ` ${DEPLOYMENT_ID}`]) {
      const candidate = input(); const row = structuredClone(target); row.deploymentId = deploymentId; candidate.deployments.push(row);
      expectInvalid(() => releaseModule.canonicalizeManagedAzureReleaseIntentV1(candidate));
    }
    for (const [path, value] of [
      ["deploymentKind", "SHARED_WORKSPACE"], ["cloudProvider", "RAILWAY"], ["environment", "staging"],
      ["deploymentStatus", "SUSPENDED"], ["provisioningStatus", "inactive"], ["releaseEligible", false],
      ["provider", "Azure"], ["group", "selfserve"], ["workload", "managed-customers "],
    ]) {
      const candidate = input(); candidate.deployments[0][path] = value;
      expectInvalid(() => releaseModule.canonicalizeManagedAzureReleaseIntentV1(candidate));
    }
  });
  test("rejects target, SHA, source tag, manifest, and digest near misses", () => {
    const mutations = [
      (value) => { value.gitSha = SHA.toUpperCase(); },
      (value) => { value.gitSha = "a".repeat(39); },
      (value) => { value.deployments[0].azure.subscriptionId = "not-a-uuid"; },
      (value) => { value.deployments[0].azure.acrServer = "foreign.azurecr.io"; },
      (value) => { value.deployments[0].azure.workerAppName = "managed-web"; },
      (value) => { value.manifests.web.sourceTag = value.manifests.worker.sourceTag; },
      (value) => { value.manifests.web.sourceTag = value.manifests.web.sourceTag.replace(`sha-${SHA}`, "latest"); },
      (value) => { value.manifests.web.raw = JSON.stringify({ nested: { digest: WEB_DIGEST } }); },
      (value) => { value.manifests.web.raw = JSON.stringify([WEB_DIGEST]); },
      (value) => { value.manifests.web.raw = `${JSON.stringify({ digest: WEB_DIGEST })} trailing`; },
      (value) => { value.manifests.web.raw = JSON.stringify({ digest: WEB_DIGEST.toUpperCase() }); },
      (value) => { value.manifests.web.raw = `{"digest":"${WEB_DIGEST}","digest":"${WEB_DIGEST}"}`; },
    ];
    for (const mutate of mutations) { const candidate = input(); mutate(candidate); expectInvalid(() => releaseModule.canonicalizeManagedAzureReleaseIntentV1(candidate)); }
  });
  test("rejects unsafe object topology without evaluating accessors", () => {
    let reads = 0;
    const accessor = input();
    Object.defineProperty(accessor, "gitSha", { enumerable: true, get() { reads += 1; return SHA; } });
    expectInvalid(() => releaseModule.canonicalizeManagedAzureReleaseIntentV1(accessor));
    expect(reads).toBe(0);
    const cases = [];
    const extra = input(); extra.credential = "private-credential-canary"; cases.push(extra);
    const symbol = input(); symbol[Symbol("private-credential-canary")] = true; cases.push(symbol);
    const inherited = Object.create({ credential: "private-credential-canary" }); Object.assign(inherited, input()); cases.push(inherited);
    const nonEnumerable = input(); Object.defineProperty(nonEnumerable, "credential", { value: "private-credential-canary" }); cases.push(nonEnumerable);
    const sparse = input(); sparse.deployments.length = 2; cases.push(sparse);
    const cyclic = input(); cyclic.manifests.web = cyclic; cases.push(cyclic);
    const unselectedCycle = input(); const cyclicRow = structuredClone(target); cyclicRow.deploymentId = "00000000-0000-4000-8000-000000000199";
    cyclicRow.azure = { nested: null }; cyclicRow.azure.nested = cyclicRow.azure; unselectedCycle.deployments.push(cyclicRow); cases.push(unselectedCycle);
    let traps = 0; const unselectedProxy = input(); const proxyRow = structuredClone(target); proxyRow.deploymentId = "00000000-0000-4000-8000-000000000199";
    proxyRow.azure = new Proxy({}, { ownKeys() { traps += 1; throw new Error("private-credential-canary"); } }); unselectedProxy.deployments.push(proxyRow); cases.push(unselectedProxy);
    const hiddenCycle = input(); const cyclicFieldRow = structuredClone(target); cyclicFieldRow.deploymentId = "00000000-0000-4000-8000-000000000199";
    cyclicFieldRow.provider = {}; cyclicFieldRow.provider.self = cyclicFieldRow.provider; hiddenCycle.deployments.push(cyclicFieldRow); cases.push(hiddenCycle);
    const hiddenProxy = input(); const proxyFieldRow = structuredClone(target); proxyFieldRow.deploymentId = "00000000-0000-4000-8000-000000000199";
    proxyFieldRow.group = new Proxy({}, { ownKeys() { traps += 1; throw new Error("private-credential-canary"); } }); hiddenProxy.deployments.push(proxyFieldRow); cases.push(hiddenProxy);
    const deep = input(); let cursor = deep.deployments[0].azure; for (let depth = 0; depth < 2_000; depth += 1) { cursor.nested = {}; cursor = cursor.nested; } cases.push(deep);
    cases.push([]); cases.push({ deployments: [], gitSha: SHA, manifests: {} });
    for (const candidate of cases) expectInvalid(() => releaseModule.canonicalizeManagedAzureReleaseIntentV1(candidate));
    expect(traps).toBe(0);
    const proxy = new Proxy(input(), { ownKeys() { throw new Error("private-credential-canary"); } });
    expectInvalid(() => releaseModule.canonicalizeManagedAzureReleaseIntentV1(proxy));
    Object.defineProperty(Object.prototype, "credential", { configurable: true, enumerable: true, value: "private-credential-canary" });
    let pollutedError; try { releaseModule.canonicalizeManagedAzureReleaseIntentV1(input()); } catch (error) { pollutedError = error; } finally { delete Object.prototype.credential; }
    expect(pollutedError?.message).toBe("MANAGED_AZURE_RELEASE_INPUT_INVALID");
    Object.defineProperty(Array.prototype, "credential", { configurable: true, enumerable: true, value: "private-credential-canary" });
    try { expectInvalid(() => releaseModule.canonicalizeManagedAzureReleaseIntentV1(input())); } finally { delete Array.prototype.credential; }
  });
  test("request value canonicalizer rejects every mutation and builder input", () => {
    const intent = releaseModule.canonicalizeManagedAzureReleaseIntentV1(input());
    const request = releaseModule.canonicalizeManagedAzureImportRequestV1({ intent, role: "web" });
    const mutations = [
      (value) => { value.mode = "Force"; },
      (value) => { value.binding.role = "worker"; },
      (value) => { value.binding.sourceDigest = WORKER_DIGEST; },
      (value) => { value.binding.sourceDigestRef += "x"; },
      (value) => { value.binding.destinationRepository = "other/web"; },
      (value) => { value.binding.destinationTag = "corgtex/web:latest"; },
      (value) => { value.binding.sourceDigestRef = 1n; },
      (value) => { value.target.acrServer = "foreign.azurecr.io"; },
      (value) => { value.extension = true; },
    ];
    for (const mutate of mutations) { const candidate = structuredClone(request); mutate(candidate); expectInvalid(() => releaseModule.canonicalizeManagedAzureImportRequestValueV1(candidate)); }
    const accessor = structuredClone(request); Object.defineProperty(accessor.binding, "sourceDigest", { enumerable: true, get() { return WEB_DIGEST; } });
    expectInvalid(() => releaseModule.canonicalizeManagedAzureImportRequestValueV1(accessor));
    expectInvalid(() => releaseModule.canonicalizeManagedAzureImportRequestValueV1(new Proxy(request, {})));
    expectInvalid(() => releaseModule.canonicalizeManagedAzureImportRequestValueV1({ intent, role: "web" }));
    const nullRecord = (value) => Object.assign(Object.create(null), value); const nullRequest = nullRecord({ ...request, target: nullRecord({ ...request.target }), binding: nullRecord({ ...request.binding }) });
    Object.defineProperty(Object.prototype, "credential", { configurable: true, enumerable: true, value: "private-credential-canary" });
    let pollutedRequestError; try { releaseModule.canonicalizeManagedAzureImportRequestValueV1(nullRequest); } catch (error) { pollutedRequestError = error; } finally { delete Object.prototype.credential; }
    expect(pollutedRequestError?.message).toBe("MANAGED_AZURE_RELEASE_INPUT_INVALID"); expect(pollutedRequestError?.message).not.toContain("private-credential-canary");
  });
  test("returns only ABSENT, MATCH, or CONFLICT with an exact digest-pinned image", () => {
    const intent = releaseModule.canonicalizeManagedAzureReleaseIntentV1(input());
    const request = releaseModule.canonicalizeManagedAzureImportRequestV1({ intent, role: "web" });
    const compare = (destinationDigest) => releaseModule.compareManagedAzureDestinationDigestV1({ expectedRequest: request, observedRequest: structuredClone(request), destinationDigest });
    expect(compare(null)).toMatchObject({ state: "ABSENT", destinationDigest: null, destinationImage: null });
    expect(compare(WEB_DIGEST)).toMatchObject({ state: "MATCH", destinationDigest: WEB_DIGEST,
      destinationImage: `acrmanaged.azurecr.io/corgtex/web@${WEB_DIGEST}` });
    expect(compare(WORKER_DIGEST)).toMatchObject({ state: "CONFLICT", destinationDigest: WORKER_DIGEST, destinationImage: null });
    expect(Object.keys(compare(null))).toStrictEqual(["schemaVersion", "request", "state", "destinationDigest", "destinationImage"]);
    expect(Object.isFrozen(compare(WEB_DIGEST))).toBe(true);
    const drifted = structuredClone(request); drifted.binding.destinationTag = "corgtex/web:latest";
    expectInvalid(() => releaseModule.compareManagedAzureDestinationDigestV1({ expectedRequest: request, observedRequest: drifted, destinationDigest: null }));
    expectInvalid(() => compare(WEB_DIGEST.toUpperCase()));
    const workerRequest = releaseModule.canonicalizeManagedAzureImportRequestV1({ intent, role: "worker" });
    const originalToJSON = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"); let toJSONCalls = 0;
    try {
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value() { return "same"; } });
      expectInvalid(() => releaseModule.compareManagedAzureDestinationDigestV1({ expectedRequest: request, observedRequest: workerRequest, destinationDigest: WEB_DIGEST }));
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value() { toJSONCalls += 1; throw new Error("private-credential-canary"); } });
      expect(compare(WEB_DIGEST).state).toBe("MATCH"); expect(toJSONCalls).toBe(0);
    } finally {
      if (originalToJSON) Object.defineProperty(Object.prototype, "toJSON", originalToJSON); else delete Object.prototype.toJSON;
    }
  });
});
