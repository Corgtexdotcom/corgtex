import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { captureTenantPurgeRootFields } from "./tenant-purge-observation-kernel";
import * as kernel from "./tenant-purge-value-scalar-kernel";

const { compileTenantPurgeScalarSpec, copyTenantPurgeScalar, invalidTenantPurgeValue, observeTenantPurgeValue } = kernel;
function caught(operation: () => unknown, status = 400) {
  try { operation(); } catch (error) { expect(error).toBeInstanceOf(AppError); expect(error).toMatchObject({ status, code: status === 400 ? "TENANT_PURGE_CONTRACT_INVALID" : "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED" }); expect(Object.isFrozen(error)).toBe(true); return error as AppError; }
  throw new Error("expected failure");
}
function invalid(values: unknown[]) { for (const value of values) caught(() => value instanceof Function ? value() : copyTenantPurgeScalar(value, { kind: "redactionKey" })); }

describe("tenant purge value scalar kernel", () => {
  it("normalizes every bridge throw once into fresh fixed 400 errors", () => {
    let calls = 0; expect(observeTenantPurgeValue(() => { calls += 1; return "ok"; })).toBe("ok"); expect(calls).toBe(1);
    const stale400 = caught(invalidTenantPurgeValue); const stale403 = caught(() => captureTenantPurgeRootFields({ privateAuthority: false }), 403);
    const forged = new AppError(403, "FORGED", "forged"); const revoked = Proxy.revocable(new Error("revoked"), {}); revoked.revoke();
    const thrown = ["primitive", new Error("ordinary"), forged, new Proxy(forged, {}), stale400, stale403, revoked.proxy]; const replacements: AppError[] = [];
    for (const value of thrown) { const replacement = caught(() => observeTenantPurgeValue(() => { throw value; })); expect(Object.is(replacement, value)).toBe(false); replacements.push(replacement); }
    let nested: unknown; const outer = caught(() => observeTenantPurgeValue(() => { try { invalidTenantPurgeValue(); } catch (error) { nested = error; throw error; } })); expect(outer).not.toBe(nested);
    for (let index = 1; index < replacements.length; index += 1) expect(replacements[index]).not.toBe(replacements[index - 1]); expect(invalidTenantPurgeValue).toThrow(); expect(caught(invalidTenantPurgeValue)).not.toBe(caught(invalidTenantPurgeValue));
  });

  it("compiles all eight exact detached scalar specs and rejects inexact shapes", () => {
    const specs: Record<string, unknown>[] = [{ kind: "null" }, { kind: "boolean" }, { kind: "integer", minimum: -2, maximum: 2 }, { kind: "string", maximumLength: 4 }, { kind: "uuid" }, { kind: "sha" }, { kind: "dateIso" }, { kind: "redactionKey" }];
    for (const spec of specs) { const compiled = compileTenantPurgeScalarSpec(spec); expect(Object.getPrototypeOf(compiled)).toBeNull(); expect(Object.isFrozen(compiled)).toBe(true); expect(compiled).toEqual(spec); }
    const mutable = { kind: "integer" as const, minimum: 1, maximum: 2 }; const detached = compileTenantPurgeScalarSpec(mutable); mutable.minimum = -100; expect(detached).toEqual({ kind: "integer", minimum: 1, maximum: 2 });
    let getters = 0; const accessor = { kind: "string" }; Object.defineProperty(accessor, "maximumLength", { enumerable: true, get() { getters += 1; return 2; } });
    const hidden = { kind: "null" }; Object.defineProperty(hidden, "extra", { value: true }); const symbol = { kind: "null", [Symbol("extra")]: true };
    const duplicate = new Proxy({ kind: "null" }, { ownKeys() { return ["kind", "kind"]; } }); const drift = new Proxy({ kind: "integer", minimum: 0, maximum: 1 }, { getOwnPropertyDescriptor(target, key) { return key === "minimum" ? undefined : Reflect.getOwnPropertyDescriptor(target, key); } });
    for (const spec of [accessor, hidden, symbol, {}, { kind: "null", extra: true }, Object.assign(Object.create({}), { kind: "null" }), duplicate, drift, { kind: "unknown" }, { kind: "integer", minimum: 2, maximum: 1 }, { kind: "integer", minimum: 0.5, maximum: 1 }, { kind: "string", maximumLength: 0 }, { kind: "string", maximumLength: 4097 }]) caught(() => compileTenantPurgeScalarSpec(spec));
    expect(getters).toBe(0);
  });

  it("copies only exact bounded primitive scalars", () => {
    expect(copyTenantPurgeScalar(null, { kind: "null" })).toBeNull(); expect(copyTenantPurgeScalar(true, { kind: "boolean" })).toBe(true);
    expect(copyTenantPurgeScalar(-2, { kind: "integer", minimum: -2, maximum: 2 })).toBe(-2); expect(copyTenantPurgeScalar("four", { kind: "string", maximumLength: 4 })).toBe("four");
    for (const [value, spec] of [[undefined, { kind: "null" }], [1, { kind: "boolean" }], ["1", { kind: "integer", minimum: 0, maximum: 2 }], [0.5, { kind: "integer", minimum: 0, maximum: 2 }], [Number.MAX_SAFE_INTEGER + 1, { kind: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }], [3, { kind: "integer", minimum: 0, maximum: 2 }], [{ toString: () => "x" }, { kind: "string", maximumLength: 2 }], ["long", { kind: "string", maximumLength: 3 }]] as const) caught(() => copyTenantPurgeScalar(value, spec));
  });

  it("uses captured direct RegExp exec after early and late poisoning (finding 17)", () => {
    const originalTest = RegExp.prototype.test; const originalExec = RegExp.prototype.exec;
    function poison() { RegExp.prototype.test = () => true; RegExp.prototype.exec = (() => ({ owned: true })) as unknown as typeof RegExp.prototype.exec; }
    function run(value: string, kind: "uuid" | "sha", late: boolean) { const spec = new Proxy({ kind }, { getOwnPropertyDescriptor(target, key) { if (!late && key === "kind") poison(); return Object.getOwnPropertyDescriptor(target, key); }, ownKeys(target) { if (late) poison(); return Reflect.ownKeys(target); } }); try { return copyTenantPurgeScalar(value, spec); } finally { RegExp.prototype.test = originalTest; RegExp.prototype.exec = originalExec; } }
    expect(run("123e4567-e89b-12d3-a456-426614174000", "uuid", false)).toContain("-"); expect(run("a".repeat(40), "sha", true)).toHaveLength(40);
    for (const [value, kind, late] of [["00000000-0000-0000-0000-000000000000", "uuid", false], ["123E4567-E89B-12D3-A456-426614174000", "uuid", true], ["A".repeat(40), "sha", false]] as const) caught(() => run(value, kind, late));
  });

  it("copies only exact Dates to detached ISO text without coercion", () => {
    const source = new Date("2026-08-14T12:34:56.789Z"); const iso = copyTenantPurgeScalar(source, { kind: "dateIso" }); source.setTime(0); expect(iso).toBe("2026-08-14T12:34:56.789Z");
    const extra = new Date(); Object.defineProperty(extra, "hidden", { value: true }); const symbol = new Date(); Object.defineProperty(symbol, Symbol("extra"), { value: true }); class DateChild extends Date {}
    let coercions = 0; const coercible = { [Symbol.toPrimitive]() { coercions += 1; return 0; } }; for (const value of [new Date(Number.NaN), extra, symbol, new DateChild(), new Proxy(new Date(), {}), {}, coercible]) caught(() => copyTenantPurgeScalar(value, { kind: "dateIso" })); expect(coercions).toBe(0);
    const originalDate = globalThis.Date; const getTime = Date.prototype.getTime; const toISOString = Date.prototype.toISOString; const spec = new Proxy({ kind: "dateIso" as const }, { getOwnPropertyDescriptor(target, key) { globalThis.Date = function PoisonedDate() { throw "date"; } as unknown as DateConstructor; originalDate.prototype.getTime = () => { throw "time"; }; originalDate.prototype.toISOString = () => { throw "iso"; }; return Object.getOwnPropertyDescriptor(target, key); } });
    try { expect(copyTenantPurgeScalar(new originalDate(0), spec)).toBe("1970-01-01T00:00:00.000Z"); } finally { globalThis.Date = originalDate; originalDate.prototype.getTime = getTime; originalDate.prototype.toISOString = toISOString; }
  });

  it("bounds and intrinsically copies exact fixed-buffer redaction keys (findings 4 and 6)", () => {
    for (const length of [32, 64]) { const source = new Uint8Array(length); for (let index = 0; index < length; index += 1) source[index] = index; const copied = copyTenantPurgeScalar(source, { kind: "redactionKey" }) as readonly number[]; source.fill(255); expect(copied).toHaveLength(length); expect(copied[1]).toBe(1); expect(Object.getPrototypeOf(copied)).toBeNull(); expect(Object.isFrozen(copied)).toBe(true); }
    invalid([new Uint8Array(31), new Uint8Array(65), new DataView(new ArrayBuffer(32)), new Proxy(new Uint8Array(32), {}), new (class extends Uint8Array {})(32), Object.setPrototypeOf({}, Uint8Array.prototype)]);
    for (const ctor of [Int8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array]) caught(() => copyTenantPurgeScalar(Reflect.construct(ctor, [32]), { kind: "redactionKey" }));
    const extra = new Uint8Array(32); Object.defineProperty(extra, "extra", { value: true }); const symbol = new Uint8Array(32); Object.defineProperty(symbol, Symbol("extra"), { value: true }); const iterator = new Uint8Array(32); Object.defineProperty(iterator, Symbol.iterator, { value: function* () { yield 1; } }); let getters = 0; const accessor = new Uint8Array(32); Object.defineProperty(accessor, "extra", { get() { getters += 1; } }); invalid([extra, symbol, iterator, accessor]); expect(getters).toBe(0);
    if (typeof SharedArrayBuffer === "function") caught(() => copyTenantPurgeScalar(new Uint8Array(new SharedArrayBuffer(32)), { kind: "redactionKey" }));
    const resizable = Reflect.construct(ArrayBuffer, [32, { maxByteLength: 64 }]) as ArrayBuffer; caught(() => copyTenantPurgeScalar(new Uint8Array(resizable), { kind: "redactionKey" }));
    const ambientIterator = Uint8Array.prototype[Symbol.iterator]; Uint8Array.prototype[Symbol.iterator] = function() { throw new Error("iteration"); }; try { expect(copyTenantPurgeScalar(new Uint8Array(32), { kind: "redactionKey" })).toHaveLength(32); } finally { Uint8Array.prototype[Symbol.iterator] = ambientIterator; }
  });

  it("uses captured intrinsics when early and late spec traps poison every ambient family", () => {
    const ta = Object.getPrototypeOf(Uint8Array.prototype); const originals = { Object: globalThis.Object, Reflect: globalThis.Reflect, Proxy: globalThis.Proxy, Array: globalThis.Array, String: globalThis.String, Number: globalThis.Number, RegExp: globalThis.RegExp, Date: globalThis.Date, Uint8Array: globalThis.Uint8Array, ArrayBuffer: globalThis.ArrayBuffer,
      create: Object.create, define: Object.defineProperty, freeze: Object.freeze, descriptor: Object.getOwnPropertyDescriptor, prototype: Object.getPrototypeOf, hasOwn: Object.hasOwn, setPrototype: Object.setPrototypeOf, apply: Reflect.apply, construct: Reflect.construct, keys: Reflect.ownKeys, safe: Number.isSafeInteger, integer: Number.isInteger, finite: Number.isFinite, exec: RegExp.prototype.exec, time: Date.prototype.getTime, iso: Date.prototype.toISOString, set: Uint8Array.prototype.set,
      taLength: Object.getOwnPropertyDescriptor(ta, "byteLength")!, taBuffer: Object.getOwnPropertyDescriptor(ta, "buffer")!, abLength: Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!, abResizable: Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")! };
    const date = new Date(0); const bytes = new Uint8Array(32);
    function poison() { originals.define(ta, "byteLength", { ...originals.taLength, get() { throw "ta-length"; } }); originals.define(ta, "buffer", { ...originals.taBuffer, get() { throw "ta-buffer"; } }); originals.define(originals.ArrayBuffer.prototype, "byteLength", { ...originals.abLength, get() { throw "ab-length"; } }); originals.define(originals.ArrayBuffer.prototype, "resizable", { ...originals.abResizable, get() { throw "ab-resizable"; } });
      Object.create = (() => { throw "create"; }) as typeof Object.create; Object.defineProperty = (() => { throw "define"; }) as typeof Object.defineProperty; Object.freeze = (() => undefined) as unknown as typeof Object.freeze; Object.getOwnPropertyDescriptor = (() => { throw "descriptor"; }) as typeof Object.getOwnPropertyDescriptor; Object.getPrototypeOf = (() => { throw "prototype"; }) as typeof Object.getPrototypeOf; Object.hasOwn = (() => false) as typeof Object.hasOwn; Object.setPrototypeOf = (() => { throw "setPrototype"; }) as typeof Object.setPrototypeOf; Reflect.apply = (() => { throw "apply"; }) as typeof Reflect.apply; Reflect.construct = (() => { throw "construct"; }) as typeof Reflect.construct; Reflect.ownKeys = (() => { throw "keys"; }) as typeof Reflect.ownKeys; Number.isSafeInteger = (() => false) as typeof Number.isSafeInteger; Number.isInteger = (() => false) as typeof Number.isInteger; Number.isFinite = (() => false) as typeof Number.isFinite; RegExp.prototype.exec = (() => null) as typeof RegExp.prototype.exec; Date.prototype.getTime = () => { throw "time"; }; Date.prototype.toISOString = () => { throw "iso"; }; Uint8Array.prototype.set = () => { throw "set"; }; Object.assign(globalThis, { Proxy: function() { throw "proxy"; }, Array: function() { throw "array"; }, String: function() { throw "string"; }, Number: function() { throw "number"; }, RegExp: function() { throw "regexp"; }, Date: function() { throw "date"; }, Uint8Array: function() { throw "uint8"; }, ArrayBuffer: function() { throw "buffer"; } }); }
    function restore() { Object.assign(globalThis, { Proxy: originals.Proxy, Array: originals.Array, String: originals.String, Number: originals.Number, RegExp: originals.RegExp, Date: originals.Date, Uint8Array: originals.Uint8Array, ArrayBuffer: originals.ArrayBuffer }); originals.Object.create = originals.create; originals.Object.defineProperty = originals.define; originals.Object.freeze = originals.freeze; originals.Object.getOwnPropertyDescriptor = originals.descriptor; originals.Object.getPrototypeOf = originals.prototype; originals.Object.hasOwn = originals.hasOwn; originals.Object.setPrototypeOf = originals.setPrototype; originals.Reflect.apply = originals.apply; originals.Reflect.construct = originals.construct; originals.Reflect.ownKeys = originals.keys; originals.Number.isSafeInteger = originals.safe; originals.Number.isInteger = originals.integer; originals.Number.isFinite = originals.finite; originals.RegExp.prototype.exec = originals.exec; originals.Date.prototype.getTime = originals.time; originals.Date.prototype.toISOString = originals.iso; originals.Uint8Array.prototype.set = originals.set; originals.define(ta, "byteLength", originals.taLength); originals.define(ta, "buffer", originals.taBuffer); originals.define(originals.ArrayBuffer.prototype, "byteLength", originals.abLength); originals.define(originals.ArrayBuffer.prototype, "resizable", originals.abResizable); }
    function execute(late: boolean) { const spec = new originals.Proxy({ kind: "uuid" as const }, { getOwnPropertyDescriptor(target, key) { if (!late) poison(); return originals.descriptor(target, key); }, ownKeys(target) { if (late) poison(); return originals.keys(target); } }); try { return [copyTenantPurgeScalar("123e4567-e89b-12d3-a456-426614174000", spec), copyTenantPurgeScalar(date, { kind: "dateIso" }), copyTenantPurgeScalar(bytes, { kind: "redactionKey" })]; } finally { restore(); } }
    for (const result of [execute(false), execute(true)]) { expect(result[0]).toContain("-"); expect(result[1]).toBe("1970-01-01T00:00:00.000Z"); expect(result[2]).toHaveLength(32); }
  });

  it("exports only the approved direct-module runtime surface", () => {
    expect(Object.keys(kernel).sort()).toEqual(["compileTenantPurgeScalarSpec", "copyTenantPurgeScalar", "invalidTenantPurgeValue", "observeTenantPurgeValue"]);
  });
});
