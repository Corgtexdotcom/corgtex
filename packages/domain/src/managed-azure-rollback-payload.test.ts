import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { canonicalizeManagedAzureRollbackPayloadV1 } from "./managed-azure-rollback-payload";

const HEX_A = "a".repeat(64); const HEX_B = "b".repeat(64); const HEX_C = "c".repeat(64); const HEX_D = "d".repeat(64);
const fixture = () => ({
  schemaVersion: 1,
  target: { subscriptionId: "123e4567-e89b-12d3-a456-426614174000", resourceGroup: "rg.Safe_1", acrName: "acr12", acrServer: "acr12.azurecr.io", webAppName: "web-app", workerAppName: "worker-app" },
  previous: {
    releaseVersion: "v1.2.3+build",
    web: { containerName: "web--old", image: `acr12.azurecr.io/corgtex/web@sha256:${HEX_A}`, readyRevision: "web-app--rev-1", templateDigest: `sha256:${HEX_C}` },
    worker: { containerName: "worker--old", image: `acr12.azurecr.io/corgtex/worker@sha256:${HEX_B}`, readyRevision: "worker-app--rev-2", templateDigest: `sha256:${HEX_D}` },
  },
  incoming: { webDigest: `sha256:${HEX_C}`, workerDigest: `sha256:${HEX_D}` },
});
type Fixture = ReturnType<typeof fixture>;
const copy = () => structuredClone(fixture());
const reversedNull = (value: unknown): unknown => value !== null && typeof value === "object"
  ? Object.assign(Object.create(null) as Record<string, unknown>, Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedNull(item)])))
  : value;
const expectInvalid = (value: unknown, hidden: string[] = []) => {
  let error: unknown; try { canonicalizeManagedAzureRollbackPayloadV1(value); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AppError); const appError = error as AppError;
  expect({ status: appError.status, code: appError.code, message: appError.message }).toEqual({ status: 400, code: "MANAGED_RELEASE_INVALID_INPUT", message: "Managed release rollback payload is invalid." });
  const disclosed = `${appError.name}|${appError.message}|${JSON.stringify(appError)}`; hidden.forEach((secret) => expect(disclosed).not.toContain(secret));
};
const rejectEdits = (edits: Array<(value: Fixture) => void>) => edits.forEach((edit) => { const value = copy(); edit(value); expectInvalid(value); });

describe("managed Azure rollback payload canonicalizer", () => {
  it("reconstructs one deterministic, independently validated, deeply frozen graph", () => {
    const input = fixture(); const output = canonicalizeManagedAzureRollbackPayloadV1(input);
    expect(output).toEqual(input); expect(output).not.toBe(input); expect(output.target).not.toBe(input.target); expect(output.previous.web).not.toBe(input.previous.web);
    expect(Object.keys(output)).toEqual(["schemaVersion", "target", "previous", "incoming"]); expect(Object.keys(output.target)).toEqual(["subscriptionId", "resourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"]);
    expect(Object.keys(output.previous)).toEqual(["releaseVersion", "web", "worker"]); expect(Object.keys(output.previous.web)).toEqual(["containerName", "image", "readyRevision", "templateDigest"]); expect(Object.keys(output.incoming)).toEqual(["webDigest", "workerDigest"]);
    [output, output.target, output.previous, output.previous.web, output.previous.worker, output.incoming].forEach((record) => expect(Object.isFrozen(record)).toBe(true));
    const reversed = canonicalizeManagedAzureRollbackPayloadV1(reversedNull(fixture())); expect(JSON.stringify(reversed)).toBe(JSON.stringify(output)); expect(reversed).not.toBe(output);
    input.target.acrName = "later12"; input.previous.web.containerName = "later"; expect(output.target.acrName).toBe("acr12"); expect(output.previous.web.containerName).toBe("web--old");
    expect(Object.isFrozen(input)).toBe(false); expect(Object.isFrozen(input.target)).toBe(false); expect(() => { (output.target as { acrName: string }).acrName = "mutated"; }).toThrow(TypeError);
  });

  it("accepts exact grammar boundaries and preserves role-specific values", () => {
    const value = copy(); value.target.resourceGroup = `R${"g".repeat(89)}`; value.target.acrName = "a".repeat(50); value.target.acrServer = `${value.target.acrName}.azurecr.io`;
    value.target.webAppName = `a${"b".repeat(30)}`; value.previous.web.readyRevision = `${value.target.webAppName}--${"r".repeat(64)}`; value.previous.web.image = `${value.target.acrServer}/corgtex/web@sha256:${HEX_A}`; value.previous.worker.image = `${value.target.acrServer}/corgtex/worker@sha256:${HEX_B}`;
    value.previous.releaseVersion = `v${"z".repeat(127)}`; value.previous.web.containerName = "c".repeat(63);
    const output = canonicalizeManagedAzureRollbackPayloadV1(value); expect(output.target.webAppName).toHaveLength(31); expect(output.previous.releaseVersion).toHaveLength(128); expect(output.previous.web.containerName).toHaveLength(63);
    expect(output.previous.web.image).toContain(`/web@sha256:${HEX_A}`); expect(output.previous.worker.image).toContain(`/worker@sha256:${HEX_B}`); expect(output.incoming).toEqual({ webDigest: `sha256:${HEX_C}`, workerDigest: `sha256:${HEX_D}` });
    const nullable = copy(); nullable.previous.releaseVersion = null as never; expect(canonicalizeManagedAzureRollbackPayloadV1(nullable).previous.releaseVersion).toBeNull();
  });

  it("rejects expanded, aliased, repeated, cyclic, accessor, and Proxy topology", () => {
    const missing = copy() as Record<string, unknown>; delete missing.incoming; expectInvalid(missing);
    expectInvalid({ ...copy(), extra: true }); const inherited = Object.assign(Object.create({ private: true }) as Record<string, unknown>, copy()); expectInvalid(inherited);
    expectInvalid({ ...copy(), [Symbol("private")]: true }); const hidden = copy(); Object.defineProperty(hidden.target, "private", { value: true }); expectInvalid(hidden);
    let getterCalled = false; const accessor = copy(); Object.defineProperty(accessor.target, "subscriptionId", { enumerable: true, get: () => { getterCalled = true; return "secret-subscription"; } }); expectInvalid(accessor, ["secret-subscription"]); expect(getterCalled).toBe(false);
    const array = copy(); array.target = [] as never; expectInvalid(array); const exotic = copy(); exotic.incoming = new Date() as never; expectInvalid(exotic);
    const cycle = copy(); cycle.target = cycle as never; expectInvalid(cycle); const repeated = copy(); repeated.previous.worker = repeated.previous.web as never; expectInvalid(repeated);
    let trapped = false; const transparent = copy(); transparent.previous.web = new Proxy(transparent.previous.web, {}); expectInvalid(transparent);
    const trapping = copy(); trapping.incoming = new Proxy(trapping.incoming, { ownKeys: () => { trapped = true; throw new Error("private-trap"); } }); expectInvalid(trapping, ["private-trap"]); expect(trapped).toBe(false);
    const revoked = copy(); const proxy = Proxy.revocable(revoked.target, {}); proxy.revoke(); revoked.target = proxy.proxy; expectInvalid(revoked);
  });

  it("rejects every target identity and Azure binding near miss", () => {
    rejectEdits([
      (v) => { v.schemaVersion = 2; }, (v) => { v.target.subscriptionId = v.target.subscriptionId.toUpperCase(); }, (v) => { v.target.subscriptionId += " "; },
      (v) => { v.target.resourceGroup = ".bad"; }, (v) => { v.target.resourceGroup = "bad."; }, (v) => { v.target.resourceGroup = "bad\u0000"; },
      (v) => { v.target.acrName = "acr1"; }, (v) => { v.target.acrName = "ACR12"; }, (v) => { v.target.acrServer = "https://acr12.azurecr.io"; }, (v) => { v.target.acrServer += ":443"; }, (v) => { v.target.acrServer += "/path"; },
      (v) => { v.target.workerAppName = v.target.webAppName; }, (v) => { v.target.webAppName = `a${"b".repeat(31)}`; }, (v) => { v.target.webAppName = "web--app"; }, (v) => { v.target.webAppName = " web-app"; }, (v) => { v.target.webAppName = String.fromCharCode(0xd800); },
    ] as Array<(value: Fixture) => void>);
  });

  it("rejects rollback selector, image, revision, version, and digest near misses", () => {
    rejectEdits([
      (v) => { v.previous.web.containerName = "-web"; }, (v) => { v.previous.web.containerName = "web-"; }, (v) => { v.previous.web.containerName = "Web"; }, (v) => { v.previous.web.containerName = "w".repeat(64); },
      (v) => { v.previous.web.image = `other1.azurecr.io/corgtex/web@sha256:${HEX_A}`; }, (v) => { v.previous.web.image = `acr12.azurecr.io/corgtex/worker@sha256:${HEX_A}`; }, (v) => { v.previous.web.image = `acr12.azurecr.io/corgtex/web:sha-${HEX_A}`; }, (v) => { v.previous.web.image += "?private=1"; },
      (v) => { v.previous.web.readyRevision = "worker-app--rev-1"; }, (v) => { v.previous.web.readyRevision = "web-app--"; }, (v) => { v.previous.web.readyRevision = "web-app--rev--two"; }, (v) => { v.previous.web.readyRevision = `web-app--${"r".repeat(65)}`; },
      (v) => { v.previous.web.templateDigest = HEX_C; }, (v) => { v.previous.worker.templateDigest = `sha256:${HEX_D.toUpperCase()}`; },
      (v) => { v.previous.releaseVersion = ""; }, (v) => { v.previous.releaseVersion = " v1"; }, (v) => { v.previous.releaseVersion = "version/private"; }, (v) => { v.previous.releaseVersion = "TOKEN=private"; }, (v) => { v.previous.releaseVersion = `v${"x".repeat(128)}`; },
      (v) => { v.incoming.webDigest = HEX_C; }, (v) => { v.incoming.webDigest = `sha-${HEX_C}`; }, (v) => { v.incoming.webDigest = `acr12.azurecr.io/corgtex/web@sha256:${HEX_C}`; }, (v) => { v.incoming.workerDigest = `sha256:${HEX_D.toUpperCase()}`; },
      (v) => { (v.previous as unknown as Record<string, unknown>).third = v.previous.web; },
    ] as Array<(value: Fixture) => void>);
  });

  it("uses only the protected reader and fixed non-disclosing error boundary", () => {
    const secret = copy(); secret.target.subscriptionId = "subscription=private-customer-value"; secret.previous.web.image = "https://user:password@example.test/private"; expectInvalid(secret, ["subscription=private-customer-value", "password", "example.test"]);
    expect(() => { canonicalizeManagedAzureRollbackPayloadV1(fixture()); throw new Error("DOWNSTREAM"); }).toThrow(/^DOWNSTREAM$/);
    const source = readFileSync(new URL("./managed-azure-rollback-payload.ts", import.meta.url), "utf8"); const barrel = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source.match(/^import .*$/gm)).toEqual(['import { AppError } from "./errors";', 'import { createManagedReleaseProofReader } from "./managed-release-proof-support";']); expect(source.match(/\bexport\b/g)).toHaveLength(2);
    expect(source.match(/createManagedReleaseProofReader\(/g)).toHaveLength(1); expect(source.match(/reader\.exactRecord\(/g)).toHaveLength(12); expect(source.match(/reader\.deepFreeze\(/g)).toHaveLength(1); expect(source.match(/reader\.canonicalJsonBytes\(/g)).toHaveLength(1);
    expect(source.indexOf("reader.deepFreeze")).toBeLessThan(source.indexOf("reader.canonicalJsonBytes")); expect(source.indexOf("const reader = createManagedReleaseProofReader")).toBeGreaterThan(source.indexOf("canonicalizeManagedAzureRollbackPayloadV1"));
    expect(source).not.toMatch(/node:util|node:crypto|RegExp|Object\.get|Reflect\.|WeakSet|new Set|JSON\.stringify|prisma|@corgtex\/shared|process\.|Date\.|fetch\(|console\.|spawn\(|try\s*\{|catch\s*\{/); expect(barrel).not.toContain("managed-azure-rollback-payload");
  });
});
