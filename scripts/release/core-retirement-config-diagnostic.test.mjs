import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { identityHash, sha256 } from "../core-baseline-common.mjs";
import { privateConfigurationFingerprints as fingerprint, sealConfigurationDiagnostic as seal, openConfigurationDiagnostic as open } from "./core-retirement-config-diagnostic.mjs";

const keys = generateKeyPairSync("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const binding = { caseSha256: "a".repeat(64), workflowSha: "b".repeat(40), runId: "36901899495", runAttempt: 1,
  target: { projectId: "0c843902-611a-4141-be91-b049a36d9617", environmentId: "03856ec6-a881-47de-bd71-44207a266ac7",
    webServiceId: "dafd9062-3f96-4a42-813a-c194ac867858", workerServiceId: "42de000e-f64d-4700-9a07-05d0ca42873e" },
  querySha256: "c".repeat(64), expectedConfigSha256: "d".repeat(64), observedConfigSha256: "e".repeat(64), capturedAt: "2026-10-01T18:00:00.000Z" };
const secret = "private-fixture-credential-do-not-emit-847158";
const report = () => ({ binding: structuredClone(binding), fingerprints: fingerprint({ worker: { variables: { PRIVATE_KEY: secret }, config: { healthcheckPath: "/healthz" } } }) });

describe("private configuration fingerprint paths", () => {
  it("keeps typed canonical leaf hashes and complete escaped paths without raw values", () => {
    const map = fingerprint({ "a/b~c": { value: secret }, enabled: false, timeout: 100, nullable: null, unset: undefined });
    expect(map["/a~1b~0c/value"]).toEqual({ type: "string", sha256: identityHash(secret) });
    expect(map["/timeout"]).toEqual({ type: "number", sha256: identityHash(100) });
    expect(map["/nullable"]).toEqual({ type: "null", sha256: identityHash(null) });
    expect(map["/unset"]).toEqual({ type: "undefined" });
    expect(JSON.stringify(map)).not.toContain(secret);
  });
  it("distinguishes absent, null, undefined, empty containers and array order", () => {
    const values = [{}, { key: null }, { key: undefined }, [], [null], ["a", "b"], ["b", "a"]];
    expect(new Set(values.map(value => JSON.stringify(fingerprint(value)))).size).toBe(values.length);
    expect(fingerprint({ empty: {}, array: [] })["/empty"]).toEqual({ type: "object", keys: [] });
    expect(fingerprint({ empty: {}, array: [] })["/array"]).toEqual({ type: "array", length: 0 });
  });
  it("is invariant under canonical object key reordering and exposes exact changed paths", () => {
    const before = { config: { a: true, z: [1, 2] }, variables: { token: secret } };
    const reordered = { variables: { token: secret }, config: { z: [1, 2], a: true } };
    expect(identityHash(before)).toBe(identityHash(reordered));
    expect(fingerprint(before)).toEqual(fingerprint(reordered));
    const after = structuredClone(before); after.config.z[1] = 3;
    const left = fingerprint(before), right = fingerprint(after);
    expect(Object.keys(left).filter(path => JSON.stringify(left[path]) !== JSON.stringify(right[path]))).toEqual(["/config/z/1"]);
  });
  it("handles prototype-looking keys without losing paths", () => {
    const value = JSON.parse('{"__proto__":{"constructor":"private"}}');
    expect(fingerprint(value)["/__proto__/constructor"]).toEqual({ type: "string", sha256: identityHash("private") });
  });
  it.each([NaN, Infinity, new Date(), new Array(2), () => {}, 1n])("rejects non-JSON/sparse values %s", value => {
    expect(() => fingerprint(value)).toThrow("CORE_RETIREMENT_CONFIG_DIAGNOSTIC_INVALID");
  });
  it("rejects cyclic and overdeep structures", () => {
    const cycle = {}; cycle.self = cycle; expect(() => fingerprint(cycle)).toThrow();
    let deep = {}; for (let i = 0; i < 70; i++) deep = { child: deep }; expect(() => fingerprint(deep)).toThrow();
  });
});

describe("authenticated encrypted configuration diagnostic", () => {
  it("roundtrips metadata and fingerprints while emitting no private names or values", () => {
    const plain = report(), envelope = seal(plain, keys.publicKey);
    expect(open(envelope, keys.privateKey, binding)).toEqual(plain);
    expect(envelope.recipientSha256).toBe(sha256(keys.publicKey));
    expect(envelope.binding).toEqual(binding);
    expect(JSON.stringify(envelope)).not.toContain("PRIVATE_KEY");
    expect(JSON.stringify(envelope)).not.toContain("healthcheckPath");
    for (const bytes of [Buffer.from(JSON.stringify(plain)), Buffer.from(JSON.stringify(envelope)), Buffer.from(envelope.ciphertext, "base64")]) {
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(1024 * 1024);
  });
  it("uses fresh keys and IVs for each seal", () => {
    const first = seal(report(), keys.publicKey), second = seal(report(), keys.publicKey);
    for (const field of ["wrappedKey", "iv", "tag", "ciphertext"]) expect(first[field]).not.toBe(second[field]);
  });
  it.each(["binding", "ciphertext", "tag", "recipientSha256", "wrappedKey", "iv"])("rejects tampered %s", field => {
    const envelope = seal(report(), keys.publicKey);
    if (field === "binding") envelope.binding.runId = "36901899496";
    else if (field === "recipientSha256") envelope[field] = "f".repeat(64);
    else { const bytes = Buffer.from(envelope[field], "base64"); bytes[0] ^= 1; envelope[field] = bytes.toString("base64"); }
    expect(() => open(envelope, keys.privateKey)).toThrow("CORE_RETIREMENT_CONFIG_DIAGNOSTIC_INVALID");
  });
  it("rejects expected metadata mismatch even for a valid envelope", () => {
    const expected = { ...binding, caseSha256: "f".repeat(64) };
    expect(() => open(seal(report(), keys.publicKey), keys.privateKey, expected)).toThrow();
  });
  it.each(["extra", "base64", "tagLength", "oversize", "version", "bindingExtra"])("rejects malformed envelope %s", kind => {
    const envelope = seal(report(), keys.publicKey);
    if (kind === "extra") envelope.raw = secret;
    if (kind === "base64") envelope.ciphertext += "\n";
    if (kind === "tagLength") envelope.tag = Buffer.alloc(15).toString("base64");
    if (kind === "oversize") envelope.ciphertext = "A".repeat(1024 * 1024);
    if (kind === "version") envelope.schemaVersion = 2;
    if (kind === "bindingExtra") envelope.binding.private = secret;
    expect(() => open(envelope, keys.privateKey)).toThrow();
  });
  it.each(["raw", "leafValue", "orphan", "missing", "wrongHash", "wrongPath", "huge"])("rejects invalid fingerprint report %s", kind => {
    const plain = report();
    if (kind === "raw") plain.rawConfiguration = { secret };
    if (kind === "leafValue") plain.fingerprints["/worker/variables/PRIVATE_KEY"].value = secret;
    if (kind === "orphan") plain.fingerprints["/not-parented"] = { type: "null", sha256: identityHash(null) };
    if (kind === "missing") delete plain.fingerprints["/worker/variables/PRIVATE_KEY"];
    if (kind === "wrongHash") plain.fingerprints["/worker/variables/PRIVATE_KEY"].sha256 = secret;
    if (kind === "wrongPath") { plain.fingerprints["/wrong"] = plain.fingerprints[""]; delete plain.fingerprints[""]; }
    if (kind === "huge") plain.fingerprints = fingerprint("x");
    if (kind === "huge") plain.binding.capturedAt = "x".repeat(1024 * 1024);
    expect(() => seal(plain, keys.publicKey)).toThrow();
  });
  it("rejects weak RSA and non-RSA recipients", () => {
    for (const publicKey of [generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey,
      generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey]) {
      expect(() => seal(report(), publicKey.export({ type: "spki", format: "pem" }))).toThrow();
    }
  });
});
