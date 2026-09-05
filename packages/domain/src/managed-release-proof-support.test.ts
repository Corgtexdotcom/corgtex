import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createManagedReleaseProofReader } from "./managed-release-proof-support";

const SHA = "a".repeat(40);
const HEX = "b".repeat(64);
const DIGEST = `sha256:${HEX}`;
const UUID = "123e4567-e89b-12d3-a456-426614174000";
const makeReader = (code = "INVALID_A") => createManagedReleaseProofReader(() => { throw new Error(code); });
const rejects = (calls: Array<() => unknown>, code = "INVALID_A") => calls.forEach((call) => expect(call).toThrow(code));

describe("managed release proof reader support", () => {
  it("exposes one frozen, invocation-local reader with exact-record copies", () => {
    const reader = makeReader();
    expect(Object.isFrozen(reader)).toBe(true);
    expect(Object.keys(reader)).toEqual(["exactRecord", "literal", "enumString", "integer", "uuid", "machineId", "version", "gitSha", "imageTag", "sha256Hex", "digest", "azureResourceGroup", "azureAcrName", "azureAcrServer", "azureAppName", "azureContainerName", "azureImage", "azureRevision", "deepFreeze", "canonicalJsonBytes"]);
    const plain = { second: 2, first: 1 };
    const copy = reader.exactRecord(plain, ["first", "second"] as const);
    const nullRecord = Object.assign(Object.create(null) as Record<string, unknown>, { first: 1, second: 2 });
    expect(copy).toEqual({ first: 1, second: 2 }); expect(copy).not.toBe(plain); expect(Object.isFrozen(copy)).toBe(true); expect(Object.keys(copy)).toEqual(["first", "second"]); expect(plain).toEqual({ second: 2, first: 1 });
    expect(makeReader().exactRecord(nullRecord, ["second", "first"] as const)).toEqual({ second: 2, first: 1 });
    expect(makeReader().exactRecord({ first: 1 }, ["first"] as const)).toEqual({ first: 1 }); expect(Object.keys(makeReader().exactRecord({ "4294967295": 1, "01": 2 }, ["01", "4294967295"] as const))).toEqual(["01", "4294967295"]);
  });

  it("rejects malformed records and every callable proxy while projecting hidden carriers into safe snapshots", () => {
    let getterCalled = false; let proxyTrapped = false; let inconsistentReads = 0;
    const accessor = Object.defineProperty({}, "x", { enumerable: true, get: () => { getterCalled = true; return 1; } });
    const hidden = Object.defineProperty({}, "x", { value: 1 });
    const inherited = Object.create({ x: 1 }) as Record<string, unknown>; inherited.y = 2;
    const symbol = { x: 1, [Symbol("private")]: 2 };
    const trapped = new Proxy({ x: 1 }, { ownKeys: () => { proxyTrapped = true; throw new Error("secret"); } });
    const inconsistent = new Proxy({ x: 1 }, { getOwnPropertyDescriptor: (target, key) => { inconsistentReads += 1; return Reflect.getOwnPropertyDescriptor(target, key); } });
    const callable = new Proxy(() => 1, { getPrototypeOf: () => { proxyTrapped = true; throw new Error("secret"); } });
    const revokedCallable = Proxy.revocable(() => 1, {}); revokedCallable.revoke();
    const revoked = Proxy.revocable({ x: 1 }, {}); revoked.revoke();
    rejects([() => makeReader().exactRecord({}, ["x"]), () => makeReader().exactRecord({ x: 1, y: 2 }, ["x"]), () => makeReader().exactRecord({ 1: "one", 2: "two" }, ["2", "1"]), () => makeReader().exactRecord({ 4294967294: "index" }, ["4294967294"]),
      () => makeReader().exactRecord(accessor, ["x"]), () => makeReader().exactRecord(hidden, ["x"]),
      () => makeReader().exactRecord(inherited, ["y"]), () => makeReader().exactRecord(symbol, ["x"]),
      () => makeReader().exactRecord([], []), () => makeReader().exactRecord(new Array(1), []),
      () => makeReader().exactRecord(new Date(), []), () => makeReader().exactRecord(new Proxy({ x: 1 }, {}), ["x"]), () => makeReader().exactRecord(trapped, ["x"]),
      () => makeReader().exactRecord(inconsistent, ["x"]), () => makeReader().exactRecord(revoked.proxy, ["x"]),
      () => makeReader().exactRecord(callable, []), () => makeReader().deepFreeze(callable), () => makeReader().canonicalJsonBytes(callable), () => makeReader().exactRecord(revokedCallable.proxy, [])]);
    const repeated = { x: 1 }; const repeatReader = makeReader(); repeatReader.exactRecord(repeated, ["x"]);
    expect(() => repeatReader.exactRecord(repeated, ["x"])).toThrow("INVALID_A");
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic; const cycleReader = makeReader(); const root = cycleReader.exactRecord(cyclic, ["self"] as const);
    expect(() => cycleReader.exactRecord(root.self, ["self"])).toThrow("INVALID_A");
    expect(getterCalled).toBe(false); expect(proxyTrapped).toBe(false); expect(inconsistentReads).toBe(0);
    let tagRead = false; let clean: unknown; Object.defineProperty(Object.prototype, Symbol.toStringTag, { configurable: true, get: () => { tagRead = true; throw new Error("LEAKED_TAG"); } });
    try { clean = makeReader().exactRecord({ x: 1 }, ["x"]); } finally { Reflect.deleteProperty(Object.prototype, Symbol.toStringTag); }
    expect(clean).toEqual({ x: 1 }); expect(tagRead).toBe(false);
    let descriptorValueRead = false; let pollutedError: unknown; Object.defineProperty(Object.prototype, "value", { configurable: true, get: () => { descriptorValueRead = true; throw new Error("LEAKED_DESCRIPTOR_VALUE"); } }); try { makeReader().exactRecord(accessor, ["x"]); } catch (error) { pollutedError = error; } finally { Reflect.deleteProperty(Object.prototype, "value"); } expect(pollutedError).toEqual(new Error("INVALID_A")); expect(descriptorValueRead).toBe(false);
    let reflectionError: unknown; const descriptors = Object.getOwnPropertyDescriptors; Object.getOwnPropertyDescriptors = () => { throw new Error("LEAKED_REFLECTION"); }; try { makeReader().exactRecord({ x: 1 }, ["x"]); } catch (error) { reflectionError = error; } finally { Object.getOwnPropertyDescriptors = descriptors; } expect(reflectionError).toEqual(new Error("INVALID_A"));
    const referent = {}; const memory = new WebAssembly.Memory({ initial: 1 }); const parameters = new URLSearchParams("x=1");
    const carriers: object[] = [new Map([["private", 1]]), new Set([1]), new ArrayBuffer(8), Promise.resolve(), new URL("https://example.test"), parameters, new WeakRef(referent), new FinalizationRegistry(() => undefined), [1].values(), "x"[Symbol.iterator](), memory, new WebAssembly.Table({ element: "anyfunc", initial: 1 }), new WebAssembly.Global({ value: "i32" }, 1), new Intl.DateTimeFormat("en"), new AbortController()];
    carriers.forEach((carrier) => Object.setPrototypeOf(carrier, Object.prototype));
    for (const carrier of carriers) { const projected = makeReader().exactRecord(carrier, []); expect(projected).toEqual({}); expect(projected).not.toBe(carrier); expect(Object.isFrozen(projected)).toBe(true); rejects([() => makeReader().deepFreeze(carrier), () => makeReader().canonicalJsonBytes(carrier)]); }
    const buffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer")!.get!; const before = (buffer.call(memory) as ArrayBuffer).byteLength; expect(WebAssembly.Memory.prototype.grow.call(memory, 1)).toBe(1); expect((buffer.call(memory) as ArrayBuffer).byteLength).toBe(before * 2);
    URLSearchParams.prototype.append.call(parameters, "y", "2"); expect(URLSearchParams.prototype.toString.call(parameters)).toBe("x=1&y=2");
    expect(makeReader().exactRecord({ x: 1 }, ["x"])).toEqual({ x: 1 });
  });

  it("parses exact primitive, identifier, SHA, tag, and digest grammars", () => {
    const reader = makeReader();
    expect(reader.literal(true, true)).toBe(true); expect(reader.literal(null, null)).toBeNull(); expect(reader.literal("SAFE", "SAFE")).toBe("SAFE");
    expect(reader.enumString("B", ["A", "B"] as const)).toBe("B"); expect(reader.integer(2, 1, 2)).toBe(2);
    expect(reader.uuid(UUID)).toBe(UUID); expect(reader.machineId("A".repeat(128))).toBe("A".repeat(128)); expect(reader.version(`v${"a".repeat(127)}`)).toBe(`v${"a".repeat(127)}`);
    expect(reader.gitSha(SHA)).toBe(SHA); expect(reader.imageTag(`sha-${SHA}`, SHA)).toBe(`sha-${SHA}`);
    expect(reader.sha256Hex(HEX)).toBe(HEX); expect(reader.digest(DIGEST)).toBe(DIGEST);
    rejects([() => reader.literal(-0, 0), () => reader.literal(undefined as never, undefined as never), () => reader.literal(" SAFE ", " SAFE "),
      () => reader.literal("✓", "✓"), () => reader.literal("x\u0000", "x\u0000"), () => reader.enumString(" A", [" A"]), () => reader.enumString("✓", ["✓"]), () => reader.enumString("A\u0000", ["A\u0000"]),
      () => reader.integer(-0, -1, 1), () => reader.integer(1.1, 1, 2), () => reader.integer(3, 1, 2), () => reader.integer(1, 2, 1),
      () => reader.uuid(UUID.toUpperCase()), () => reader.uuid(`${UUID} `), () => reader.machineId("_bad"), () => reader.machineId(`a${"b".repeat(128)}`),
      () => reader.version("+bad"), () => reader.version("v".repeat(129)), () => reader.version(String.fromCharCode(0xd800)), () => reader.gitSha(SHA.toUpperCase()), () => reader.gitSha("a".repeat(39)),
      () => reader.imageTag(`sha-${"b".repeat(40)}`, SHA), () => reader.sha256Hex(DIGEST), () => reader.digest(HEX), () => reader.digest(`sha256:${HEX.toUpperCase()}`)]);
  });

  it("enforces exact Azure resource, app, container, revision, and immutable-image subsets", () => {
    const reader = makeReader(); const acr = "acr12"; const acr50 = "a".repeat(50); const app32 = `a${"b".repeat(31)}`; const container63 = "c".repeat(63);
    expect(reader.azureResourceGroup(`R${"g".repeat(89)}`)).toBe(`R${"g".repeat(89)}`); expect(reader.azureAcrName(acr)).toBe(acr); expect(reader.azureAcrName(acr50)).toBe(acr50);
    expect(reader.azureAcrServer(`${acr}.azurecr.io`, acr)).toBe(`${acr}.azurecr.io`);
    expect(reader.azureAppName("a1")).toBe("a1"); expect(reader.azureAppName(app32)).toBe(app32);
    expect(reader.azureContainerName("a")).toBe("a"); expect(reader.azureContainerName(container63)).toBe(container63); expect(reader.azureContainerName("a--b")).toBe("a--b");
    expect(reader.azureRevision(`a1--${"c".repeat(64)}`, "a1")).toBe(`a1--${"c".repeat(64)}`);
    const image = `${acr}.azurecr.io/corgtex/web@${DIGEST}`; const parts = reader.azureImage(image, "web");
    expect(parts).toEqual({ image, acrName: acr, acrServer: `${acr}.azurecr.io`, digest: DIGEST }); expect(Object.isFrozen(parts)).toBe(true); expect(reader.azureImage(image, "web")).not.toBe(parts);
    rejects([() => reader.azureResourceGroup(".bad"), () => reader.azureResourceGroup("bad."), () => reader.azureResourceGroup(`a${"b".repeat(90)}`),
      () => reader.azureAcrName("acr1"), () => reader.azureAcrName("a".repeat(51)), () => reader.azureAcrName("ACR12"), () => reader.azureAcrServer(`https://${acr}.azurecr.io`, acr), () => reader.azureAcrServer(`${acr}.azurecr.io:443`, acr),
      () => reader.azureAppName("a"), () => reader.azureAppName(`a${"b".repeat(32)}`), () => reader.azureAppName("1a"), () => reader.azureAppName("a--b"), () => reader.azureAppName("ab-"),
      () => reader.azureContainerName("-a"), () => reader.azureContainerName("a-"), () => reader.azureContainerName("A"), () => reader.azureContainerName("a".repeat(64)),
      () => reader.azureRevision("b1--rev", "a1"), () => reader.azureRevision("a1---rev", "a1"), () => reader.azureRevision("a1--rev--two", "a1"), () => reader.azureRevision(`a1--${"c".repeat(65)}`, "a1"),
      () => reader.azureImage(`${acr}.azurecr.io/corgtex/worker@${DIGEST}`, "web"), () => reader.azureImage(`${acr}.azurecr.io/corgtex/web:${DIGEST}`, "web"),
      () => reader.azureImage(`https://${image}`, "web"), () => reader.azureImage(`${acr}.azurecr.io:443/corgtex/web@${DIGEST}`, "web"),
      () => reader.azureImage(`${image}/extra`, "web"), () => reader.azureImage(`${image}?x=1`, "web"), () => reader.azureImage(`${image}#x`, "web"),
      () => reader.azureImage(`${acr}.azurecr.io/corgtex/web@sha256:${"b".repeat(63)}`, "web"), () => reader.azureImage(image.toUpperCase(), "web")]);
  });

  it("validates a complete fresh graph before freezing it leaves-first", () => {
    const reader = makeReader(); const raw = { nested: { id: "safe" } };
    const rawRoot = reader.exactRecord(raw, ["nested"] as const); const rawNested = reader.exactRecord(rawRoot.nested, ["id"] as const);
    const nested = reader.exactRecord({ id: reader.machineId(rawNested.id) }, ["id"] as const);
    const fresh = reader.exactRecord({ nested, version: 1, enabled: true, absent: null }, ["nested", "version", "enabled", "absent"] as const);
    expect(reader.deepFreeze(fresh)).toBe(fresh); expect(Object.isFrozen(fresh)).toBe(true); expect(Object.isFrozen(fresh.nested)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false); expect(Object.isFrozen(raw.nested)).toBe(false);
    const child = { ok: 1 }; const rejected = reader.exactRecord({ child }, ["child"] as const);
    expect(() => reader.deepFreeze(rejected)).toThrow("INVALID_A"); expect(Object.isFrozen(child)).toBe(false); expect(() => reader.canonicalJsonBytes(rejected)).toThrow("INVALID_A");
    const shared = reader.exactRecord({ ok: 1 }, ["ok"] as const); const repeated = reader.exactRecord({ left: shared, right: shared }, ["left", "right"] as const);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle; const cycleSnapshot = reader.exactRecord(cycle, ["self"] as const);
    rejects([() => reader.deepFreeze(repeated), () => reader.deepFreeze(cycleSnapshot), () => makeReader().deepFreeze(fresh),
      () => makeReader().deepFreeze([1]), () => makeReader().deepFreeze(new Proxy({ ok: 1 }, { get: () => { throw new Error("secret"); } }))]);
    const keys = Array.from({ length: 1_024 }, (_, index) => `k${index}`); const wide = reader.exactRecord(Object.fromEntries(keys.map((key, index) => [key, index])), keys);
    expect(reader.deepFreeze(wide)).toBe(wide);
    const deepReader = makeReader(); let tooDeep = deepReader.exactRecord({}, []); for (let index = 0; index < 5_000; index += 1) tooDeep = deepReader.exactRecord({ child: tooDeep }, ["child"] as const);
    expect(() => deepReader.deepFreeze(tooDeep)).toThrow(/^INVALID_A$/); expect(() => deepReader.canonicalJsonBytes(tooDeep)).toThrow(/^INVALID_A$/);
  });

  it("emits deterministic bounded canonical UTF-8 bytes for the closed record subset", () => {
    const reader = makeReader(); const leftNested = reader.exactRecord({ b: true, a: "✓" }, ["b", "a"] as const); const left = reader.exactRecord({ z: 2, nested: leftNested, a: null }, ["z", "nested", "a"] as const);
    const rightNested = reader.exactRecord(Object.assign(Object.create(null) as Record<string, unknown>, { a: "✓", b: true }), ["a", "b"] as const);
    const right = reader.exactRecord(Object.assign(Object.create(null) as Record<string, unknown>, { a: null, nested: rightNested, z: 2 }), ["a", "nested", "z"] as const);
    reader.deepFreeze(left); reader.deepFreeze(right);
    const leftBytes = reader.canonicalJsonBytes(left); const rightBytes = reader.canonicalJsonBytes(right);
    expect(new TextDecoder().decode(leftBytes)).toBe('{"a":null,"nested":{"a":"✓","b":true},"z":2}'); expect(leftBytes).toEqual(rightBytes);
    const changed = reader.exactRecord({ z: 3, nested: leftNested, a: null }, ["z", "nested", "a"] as const); reader.deepFreeze(changed);
    expect(reader.canonicalJsonBytes(left)).not.toBe(leftBytes); expect(reader.canonicalJsonBytes(changed)).not.toEqual(leftBytes);
  });

  it("rejects noncanonical topology and every canonical byte bound", () => {
    const reader = makeReader(); const accessor = Object.defineProperty({}, "x", { enumerable: true, get: () => 1 }); const unvalidated = reader.exactRecord({ x: 1 }, ["x"] as const);
    const shared = { x: 1 }; const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let deep = reader.exactRecord({}, []); for (let index = 0; index < 33; index += 1) deep = reader.exactRecord({ child: deep }, ["child"] as const); reader.deepFreeze(deep);
    const keys = Array.from({ length: 1_024 }, (_, index) => `k${index}`); const crowded = reader.exactRecord(Object.fromEntries(keys.map((key, index) => [key, index])), keys); reader.deepFreeze(crowded);
    rejects([() => reader.canonicalJsonBytes([]), () => reader.canonicalJsonBytes(new Date()), () => reader.canonicalJsonBytes(accessor),
      () => reader.canonicalJsonBytes({ x: 1, [Symbol("x")]: 2 }), () => reader.canonicalJsonBytes({ left: shared, right: shared }), () => reader.canonicalJsonBytes(cycle),
      () => reader.canonicalJsonBytes(undefined), () => reader.canonicalJsonBytes(1n), () => reader.canonicalJsonBytes(() => 1), () => reader.canonicalJsonBytes(Number.NaN),
      () => reader.canonicalJsonBytes(Number.MAX_SAFE_INTEGER + 1), () => reader.canonicalJsonBytes(-0), () => reader.canonicalJsonBytes("x\u0000"),
      () => reader.canonicalJsonBytes(String.fromCharCode(0xd800)), () => reader.canonicalJsonBytes(unvalidated), () => makeReader().canonicalJsonBytes(deep), () => reader.canonicalJsonBytes(deep), () => reader.canonicalJsonBytes(crowded),
      () => reader.canonicalJsonBytes("x".repeat(16_385)), () => reader.canonicalJsonBytes(new Proxy({ x: 1 }, { ownKeys: () => { throw new Error("secret"); } }))]);
  });

  it("binds failures to each caller's fixed zero-argument thrower without catching downstream errors", () => {
    const callerA = () => createManagedReleaseProofReader(() => { throw new Error("PROOF_A_INVALID"); });
    const callerB = () => createManagedReleaseProofReader(() => { throw new Error("PROOF_B_INVALID"); });
    const malformed = [(reader: ReturnType<typeof callerA>) => reader.uuid("private-customer-id"),
      (reader: ReturnType<typeof callerA>) => reader.exactRecord(new Proxy({}, { getPrototypeOf: () => { throw new Error("leak"); } }), []),
      (reader: ReturnType<typeof callerA>) => reader.canonicalJsonBytes("credential=secret".repeat(2_000))];
    for (const parse of malformed) {
      expect(() => parse(callerA())).toThrow(/^PROOF_A_INVALID$/); expect(() => parse(callerB())).toThrow(/^PROOF_B_INVALID$/);
    }
    expect(() => { callerA().uuid(UUID); throw new Error("DOWNSTREAM"); }).toThrow(/^DOWNSTREAM$/);
  });

  it("statically confines reflection, state, imports, exports, and side effects", () => {
    const source = readFileSync(new URL("./managed-release-proof-support.ts", import.meta.url), "utf8");
    expect(source.match(/^import .*$/gm)).toEqual(['import { types as nodeTypes } from "node:util";']);
    expect(source.match(/\bexport\b/g)).toHaveLength(1); expect(source).toContain("export function createManagedReleaseProofReader");
    expect(source).not.toMatch(/AppError|node:crypto|createHash|node:child_process|process\.|Date\.|fetch\(|console\.|prisma|spawn\(/);
    expect(source.match(/new WeakSet<object>\(\)/g)).toHaveLength(3); expect(source.indexOf("new WeakSet<object>()")).toBeGreaterThan(source.indexOf("createManagedReleaseProofReader"));
    expect(source.match(/new Set<object>\(\)/g)).toHaveLength(2);
    const guard = source.slice(source.indexOf("const objectValue"), source.indexOf("const inspectRecord")); const proxy = guard.indexOf("nodeTypes.isProxy(value)");
    for (const operation of ["value === null", 'typeof value !== "object"', "Array.isArray(value)"]) expect(guard.indexOf(operation)).toBeGreaterThan(proxy);
    expect(source.match(/Object\.getPrototypeOf\(/g)).toHaveLength(1); expect(source.match(/Object\.getOwnPropertyDescriptors\(/g)).toHaveLength(1); expect(source.match(/Reflect\.ownKeys\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/Object\.prototype\.toString|const exotic|nodeTypes\.isMap/); expect(source.indexOf("Object.freeze(Object.fromEntries")).toBeLessThan(source.indexOf("snapshots.add(snapshot)"));
    const freezer = source.slice(source.indexOf("const deepFreeze"), source.indexOf("const canonicalJsonBytes")); const canonical = source.slice(source.indexOf("const canonicalJsonBytes"), source.indexOf("const reader"));
    expect(freezer.indexOf("snapshots.has(object)")).toBeLessThan(freezer.indexOf("inspectRecord(object)")); expect(freezer.indexOf("Object.freeze(objects[index]!)")).toBeLessThan(freezer.indexOf("validated.add(object)"));
    expect(canonical.indexOf("validated.has(object)")).toBeLessThan(canonical.indexOf("inspectRecord(object)"));
    expect(source.indexOf("nodeTypes.isProxy(reader)")).toBeLessThan(source.lastIndexOf("Object.freeze(reader)"));
  });
});
