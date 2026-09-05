import { describe, expect, it } from "vitest";
import { canonicalizeManagedAzureRollbackPayload } from "./managed-azure-recovery-payload";
const hex = (value: string) => value.repeat(64);
const target = { subscriptionId: "123e4567-e89b-42d3-a456-426614174000", resourceGroup: "rg-safe", acrName: "acr12", acrServer: "acr12.azurecr.io", webAppName: "safe-web", workerAppName: "safe-worker" };
function v1() { return { schemaVersion: 1, target, previous: { releaseVersion: "release-1", web: { containerName: "web", image: `${target.acrServer}/corgtex/web@sha256:${hex("1")}`, readyRevision: "safe-web--old", templateDigest: `sha256:${hex("2")}` }, worker: { containerName: "worker", image: `${target.acrServer}/corgtex/worker@sha256:${hex("3")}`, readyRevision: "safe-worker--old", templateDigest: `sha256:${hex("4")}` } }, incoming: { webDigest: `sha256:${hex("5")}`, workerDigest: `sha256:${hex("6")}` } }; }
function v2() { const base = v1(); const gitSha = "a".repeat(40); return { ...base, schemaVersion: 2, incoming: { ...base.incoming, schemaApprovalDigest: `sha256:${hex("a")}` }, compatibleRecovery: { gitSha, imageTag: `sha-${gitSha}`, releaseVersion: "recovery-1", web: { image: `${target.acrServer}/corgtex/web@sha256:${hex("7")}`, digest: `sha256:${hex("7")}` }, worker: { image: `${target.acrServer}/corgtex/worker@sha256:${hex("8")}`, digest: `sha256:${hex("8")}` }, schemaCompatibilityApprovalDigest: `sha256:${hex("9")}`, acceptancePolicy: "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1", activationPolicy: "EXCLUSIVE" } }; }
describe("managed Azure compatible recovery manifest", () => {
  it("preserves historical V1 readability and canonicalizes the explicit V2 recovery pair", () => {
    expect(canonicalizeManagedAzureRollbackPayload(v1())).toMatchObject({ schemaVersion: 1 });
    const parsed = canonicalizeManagedAzureRollbackPayload(v2());
    expect(parsed).toEqual(v2()); expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen((parsed as ReturnType<typeof v2>).compatibleRecovery)).toBe(true);
  });
  it("rejects another registry, role, digest, approval, policy, release or extra field", () => {
    const mutations = [(x: ReturnType<typeof v2>) => { x.compatibleRecovery.web.image = x.compatibleRecovery.web.image.replace("acr12", "acr13"); },
      (x: ReturnType<typeof v2>) => { x.compatibleRecovery.web.image = x.compatibleRecovery.web.image.replace("/web@", "/worker@"); },
      (x: ReturnType<typeof v2>) => { x.compatibleRecovery.web.digest = `sha256:${hex("0")}`; },
      (x: ReturnType<typeof v2>) => { x.incoming.schemaApprovalDigest = hex("a"); },
      (x: ReturnType<typeof v2>) => { x.compatibleRecovery.schemaCompatibilityApprovalDigest = hex("9"); },
      (x: ReturnType<typeof v2>) => { x.compatibleRecovery.acceptancePolicy = "OTHER"; },
      (x: ReturnType<typeof v2>) => { x.compatibleRecovery.imageTag = `sha-${"b".repeat(40)}`; },
      (x: ReturnType<typeof v2>) => { Object.assign(x.compatibleRecovery, { releaseEligible: true }); }];
    for (const mutate of mutations) { const value = structuredClone(v2()); mutate(value); expect(() => canonicalizeManagedAzureRollbackPayload(value)).toThrow(); }
  });
  it("rejects getters and proxies without evaluating supplied accessors", () => {
    let read = false; const value = v2(); Object.defineProperty(value, "schemaVersion", { enumerable: true, get: () => { read = true; return 2; } });
    expect(() => canonicalizeManagedAzureRollbackPayload(value)).toThrow(); expect(read).toBe(false);
    expect(() => canonicalizeManagedAzureRollbackPayload(new Proxy(v2(), {}))).toThrow();
  });
});
