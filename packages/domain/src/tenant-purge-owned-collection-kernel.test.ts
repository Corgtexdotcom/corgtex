import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import * as kernel from "./tenant-purge-owned-collection-kernel";
import { createTenantPurgeOwnedSchema, createTenantPurgeOwnedField, captureTenantPurgeOwnedSchema, type TenantPurgeOwnedSchema } from "./tenant-purge-owned-schema-kernel";
import { createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";

const { copyTenantPurgeOwnedCollection: copy, createTenantPurgeOwnedEntry: entry } = kernel;
const schema = createTenantPurgeOwnedSchema;

function caught(operation: () => unknown): AppError {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(AppError); expect(error).toMatchObject({ status: 400, code: "TENANT_PURGE_CONTRACT_INVALID" }); expect(Object.isFrozen(error)).toBe(true); return error as AppError;
  }
  throw new Error("expected failure");
}

function vector<T>(values: readonly T[], maximum = values.length) {
  let result = createTenantPurgeOwnedVector<T>(maximum);
  for (let index = 0; index < values.length; index += 1) result = pushTenantPurgeOwnedVector(result, values[index]);
  return result;
}

function recordSchema(values: readonly (readonly [string, TenantPurgeOwnedSchema])[]) {
  return schema("record", vector(values.map(([name, value]) => createTenantPurgeOwnedField(name, value)), 64));
}

function recordValue(values: readonly (readonly [string, unknown])[]) {
  return vector(values.map(([name, value]) => entry(name, value)), 64);
}

function owned(value: object): void { expect(Object.getPrototypeOf(value)).toBeNull(); expect(Object.isFrozen(value)).toBe(true); }

describe("tenant purge owned collection kernel", () => {
  it("copies mixed values into detached deeply frozen ordered lists", () => {
    const text = schema("string", 32); const nullable = schema("nullable", schema("uuid")); const child = recordSchema([["id", text]]);
    const root = recordSchema([["1", text], ["0", nullable], ["when", schema("dateIso")], ["key", schema("redactionKey")], ["a", child], ["b", child]]);
    const bytes = vector(Array.from({ length: 32 }, (_, index) => index)); const shared = recordValue([["id", "same"]]);
    const source = recordValue([["1", "before"], ["0", null], ["when", 0], ["key", bytes], ["a", shared], ["b", shared]]);
    const result = copy(source, root) as readonly kernel.TenantPurgeOwnedOrderedEntry[]; const replay = copy(source, root) as readonly kernel.TenantPurgeOwnedOrderedEntry[];
    expect(Array.from(result, (item) => item[0])).toEqual(["1", "0", "when", "key", "a", "b"]); expect(result[0][1]).toBe("before"); expect(result[2][1]).toBe("1970-01-01T00:00:00.000Z");
    expect((result[3][1] as readonly number[])[31]).toBe(31); expect(result[4][1]).not.toBe(result[5][1]); expect(replay).not.toBe(result); expect(replay[3][1]).not.toBe(result[3][1]);
    for (const value of [result, result[0], result[1], result[2], result[3], result[4], result[5], result[3][1], result[4][1], result[5][1]] as object[]) owned(value); expect(Reflect.ownKeys(result)).toEqual(["0", "1", "2", "3", "4", "5", "length"]); expect(Object.getOwnPropertyDescriptor(result[0], "0")).toMatchObject({ value: "1", enumerable: true, writable: false });
  });

  it("rejects raw holes, extras, proxies, and hostile entry values before caller traps", () => {
    const item = schema("string", 8); const array = schema("array", item, 3, false); const record = recordSchema([["x", item]]); let traps = 0; const trap = () => { traps += 1; throw new Error("caller trap"); };
    const hostile = new Proxy(Object.create(null), { get: trap, has: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    const hugeKeys = new Proxy({}, { ownKeys() { traps += 1; return Array.from({ length: 100_002 }, (_, index) => String(index)); }, getOwnPropertyDescriptor: trap });
    const hidden = ["a"]; Object.defineProperty(hidden, "extra", { value: true }); const symbol = Object.assign(["a"], { [Symbol("extra")]: true });
    for (const raw of [new Array(3), ["a", , "c"], ["a", "b", ,], Object.assign(["a"], { "01": "x" }), Object.assign(["a"], { "-0": "x" }), Object.assign(["a"], { "1e0": "x" }), hidden, symbol, hugeKeys, hostile]) caught(() => copy(raw, array));
    const accessor = ["a"]; Object.defineProperty(accessor, "0", { get: trap }); const objectAccessor = {}; Object.defineProperty(objectAccessor, "x", { get: trap }); caught(() => copy(accessor, array)); caught(() => copy(objectAccessor, record)); caught(() => copy(hostile, record));
    const held = entry("x", hostile); expect(traps).toBe(0); caught(() => copy(recordValue([["x", hostile]]), record)); caught(() => copy(vector([held]), recordSchema([["x", schema("dateIso")]]))); expect(traps).toBe(0);
  });

  it("authenticates entry/vector/schema brands and validates record names before descent", () => {
    const text = schema("string", 8); const spec = recordSchema([["1", text], ["0", text], ["a", text]]); const genuine = entry("1", "one"); owned(genuine as object); expect(Reflect.ownKeys(genuine as object)).toEqual([]);
    for (const name of ["", "x".repeat(129), 0, {}, Symbol("x")]) caught(() => entry(name, null));
    for (const fake of [null, {}, Object.freeze({}), Object.create(null), text, vector([]), captureTenantPurgeOwnedSchema(text)]) caught(() => copy(vector([fake, entry("0", "zero"), entry("a", "a")]), spec));
    let traps = 0; const trap = () => { traps += 1; throw new Error("trap"); }; const wrapped = new Proxy(genuine as object, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    const revoked = Proxy.revocable(genuine as object, {}); revoked.revoke(); caught(() => copy(vector([wrapped, entry("0", "zero"), entry("a", "a")]), spec)); caught(() => copy(vector([revoked.proxy, entry("0", "zero"), entry("a", "a")]), spec)); expect(traps).toBe(0);
    for (const values of [[genuine], [genuine, entry("a", "a"), entry("0", "zero")], [genuine, entry("0", "zero"), entry("0", "again")], [entry("0", "wrong"), entry("1", "wrong"), entry("a", "a")]]) caught(() => copy(vector(values), spec));
    expect(Array.from(copy(vector([genuine, entry("0", "zero"), entry("a", "a")]), spec) as readonly kernel.TenantPurgeOwnedOrderedEntry[], (item) => item[0])).toEqual(["1", "0", "a"]);
  });

  it("enforces scalar ingress, exact byte ownership, boundaries, and fresh failures", () => {
    const date = schema("dateIso"); expect(copy(-8_640_000_000_000_000, date)).toBe("-271821-04-20T00:00:00.000Z"); expect(copy(8_640_000_000_000_000, date)).toBe("+275760-09-13T00:00:00.000Z");
    for (const invalid of [8_640_000_000_000_001, -8_640_000_000_000_001, 0.5, Number.NaN, new Date(0), new Proxy(new Date(0), {})]) caught(() => copy(invalid, date));
    const redaction = schema("redactionKey"); for (const invalid of [new Uint8Array(32), new Proxy(new Uint8Array(32), {}), Array(32).fill(0), vector(Array(31).fill(0)), vector(Array(65).fill(0)), vector([...Array(31).fill(0), 256]), vector([...Array(31).fill(0), 0.5])]) caught(() => copy(invalid, redaction));
    class Derived extends Uint8Array {} caught(() => copy(new Derived(32), redaction));
    for (const length of [32, 64]) { const result = copy(vector(Array.from({ length }, (_, index) => index % 256)), redaction) as readonly number[]; expect(result).toHaveLength(length); owned(result); }
    expect(caught(() => copy({}, date))).not.toBe(caught(() => copy({}, date)));
  });

  it("bounds depth and all returned slots before proportional nested capture", () => {
    let deep = schema("boolean"); for (let index = 1; index < 32; index += 1) deep = schema("nullable", deep); expect(copy(true, deep)).toBe(true); caught(() => schema("nullable", deep));
    const integer = schema("integer", 0, 100_000); const hundredThousand = vector(Array.from({ length: 100_000 }, (_, index) => index), 100_000);
    expect(copy(hundredThousand, schema("array", integer, 100_000, false))).toHaveLength(100_000); caught(() => copy(vector([hundredThousand]), schema("array", schema("array", integer, 100_000, false), 1, false)));
    caught(() => copy(vector([1, 2]), schema("array", integer, 1, false)));
    const nearLimit = vector(Array.from({ length: 99_963 }, () => 1), 99_963); const bytes = vector(Array(32).fill(1)); const spec = recordSchema([["items", schema("array", integer, 99_963, false)], ["key", schema("redactionKey")]]);
    caught(() => copy(recordValue([["items", nearLimit], ["key", bytes]]), spec)); for (const forged of [Object.freeze({ previous: null }), Object.create(null)]) caught(() => copy(forged, schema("array", integer, 1, false)));
  }, 20_000);

  it("deduplicates primitive results linearly with captured SameValueZero Set semantics", () => {
    const integer = schema("integer", -1, 100_000); const unique = schema("array", integer, 100_000, true); const values = Array.from({ length: 100_000 }, (_, index) => index);
    expect(copy(vector(values, 100_000), unique)).toHaveLength(100_000); const early = values.slice(); early[1] = 0; const late = values.slice(); late[99_999] = 0; caught(() => copy(vector(early, 100_000), unique)); caught(() => copy(vector(late, 100_000), unique));
    caught(() => copy(vector([0, -0]), schema("array", integer, 2, true))); caught(() => copy(vector([null, null]), schema("array", schema("nullable", integer), 2, true))); caught(() => copy(vector([0, -0]), schema("array", schema("dateIso"), 2, true)));
    const input = vector([1, 2]); const spec = schema("array", integer, 2, true); const original = { Set: globalThis.Set, has: Set.prototype.has, add: Set.prototype.add, delete: Set.prototype.delete };
    try { globalThis.Set = function PoisonedSet() { throw new Error("set"); } as unknown as SetConstructor; original.Set.prototype.has = (() => false) as typeof Set.prototype.has; original.Set.prototype.add = (() => { throw new Error("add"); }) as typeof Set.prototype.add; original.Set.prototype.delete = (() => false) as typeof Set.prototype.delete; expect(copy(input, spec)).toEqual([1, 2]); }
    finally { globalThis.Set = original.Set; original.Set.prototype.has = original.has; original.Set.prototype.add = original.add; original.Set.prototype.delete = original.delete; }
  }, 20_000);

  it("bypasses late ambient poisoning and inherited setters without retaining inputs", () => {
    const text = schema("string", 8); const spec = recordSchema([["name", text], ["items", schema("array", text, 2, false)]]); const items = vector(["a", "b"]); const input = recordValue([["name", "safe"], ["items", items]]);
    const original = { Object: globalThis.Object, Reflect: globalThis.Reflect, Array: globalThis.Array, Number: globalThis.Number, Date: globalThis.Date, Uint8Array: globalThis.Uint8Array, WeakMap: globalThis.WeakMap, Set: globalThis.Set, create: Object.create, define: Object.defineProperty, freeze: Object.freeze, setPrototype: Object.setPrototypeOf, apply: Reflect.apply, construct: Reflect.construct, safe: Number.isSafeInteger, integer: Number.isInteger, get: WeakMap.prototype.get, set: WeakMap.prototype.set, has: Set.prototype.has, add: Set.prototype.add, delete: Set.prototype.delete, zero: Object.getOwnPropertyDescriptor(Object.prototype, "0"), name: Object.getOwnPropertyDescriptor(Object.prototype, "name"), json: Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") };
    let hooks = 0; let result: unknown; let first: unknown; let second: unknown;
    try {
      original.define(Object.prototype, "0", { configurable: true, set() { hooks += 1; } }); original.define(Object.prototype, "name", { configurable: true, set() { hooks += 1; } }); original.define(Object.prototype, "toJSON", { configurable: true, value() { hooks += 1; } });
      Object.create = (() => { throw new Error("create"); }) as typeof Object.create; Object.defineProperty = (() => { throw new Error("define"); }) as typeof Object.defineProperty; Object.freeze = ((value: unknown) => value) as typeof Object.freeze; Object.setPrototypeOf = (() => { throw new Error("prototype"); }) as typeof Object.setPrototypeOf; Reflect.apply = (() => { throw new Error("apply"); }) as typeof Reflect.apply; Reflect.construct = (() => { throw new Error("construct"); }) as typeof Reflect.construct; Number.isSafeInteger = (() => false) as typeof Number.isSafeInteger; Number.isInteger = (() => false) as typeof Number.isInteger; WeakMap.prototype.get = (() => { throw new Error("get"); }) as typeof WeakMap.prototype.get; WeakMap.prototype.set = (() => { throw new Error("set"); }) as typeof WeakMap.prototype.set; Set.prototype.has = (() => false) as typeof Set.prototype.has; Set.prototype.add = (() => { throw new Error("add"); }) as typeof Set.prototype.add; Set.prototype.delete = (() => false) as typeof Set.prototype.delete;
      globalThis.Array = function PoisonedArray() { throw new Error("array"); } as unknown as ArrayConstructor; globalThis.Date = function PoisonedDate() { throw new Error("date"); } as unknown as DateConstructor; globalThis.Uint8Array = function PoisonedBytes() { throw new Error("bytes"); } as unknown as Uint8ArrayConstructor; globalThis.WeakMap = function PoisonedWeakMap() { throw new Error("weakmap"); } as unknown as WeakMapConstructor; globalThis.Set = function PoisonedSet() { throw new Error("set"); } as unknown as SetConstructor;
      result = copy(input, spec); try { copy({}, spec); } catch (error) { first = error; } try { entry("", null); } catch (error) { second = error; }
    } finally {
      globalThis.Object = original.Object; globalThis.Reflect = original.Reflect; globalThis.Array = original.Array; globalThis.Number = original.Number; globalThis.Date = original.Date; globalThis.Uint8Array = original.Uint8Array; globalThis.WeakMap = original.WeakMap; globalThis.Set = original.Set; original.Object.create = original.create; original.Object.defineProperty = original.define; original.Object.freeze = original.freeze; original.Object.setPrototypeOf = original.setPrototype; original.Reflect.apply = original.apply; original.Reflect.construct = original.construct; original.Number.isSafeInteger = original.safe; original.Number.isInteger = original.integer; original.WeakMap.prototype.get = original.get; original.WeakMap.prototype.set = original.set; original.Set.prototype.has = original.has; original.Set.prototype.add = original.add; original.Set.prototype.delete = original.delete;
      for (const [key, saved] of [["0", original.zero], ["name", original.name], ["toJSON", original.json]] as const) { if (saved) original.define(original.Object.prototype, key, saved); else delete (original.Object.prototype as Record<string, unknown>)[key]; }
    }
    expect((result as readonly kernel.TenantPurgeOwnedOrderedEntry[])[1][1]).toEqual(["a", "b"]); expect(hooks).toBe(0); expect(first).toMatchObject({ status: 400 }); expect(second).toMatchObject({ status: 400 }); expect(first).not.toBe(second);
  });

  it("keeps predecessor hashes and the runtime/static surface exact", () => {
    expect(Object.keys(kernel).sort()).toEqual(["copyTenantPurgeOwnedCollection", "createTenantPurgeOwnedEntry"]);
    const source = readFileSync(new URL("./tenant-purge-owned-collection-kernel.ts", import.meta.url), "utf8"); expect(source).not.toMatch(/ownKeys|Object\.keys|for\s*\([^)]*\sin\s|\bProxy\b|\.push\(|\basync\b|topology|target|blocker|provider|reader|callback/);
    const hash = (name: string) => createHash("sha256").update(readFileSync(new URL(name, import.meta.url))).digest("hex"); expect(hash("./tenant-purge-value-scalar-kernel.ts")).toBe("1fb3bc13f0f033d95880bf908cc578ebf1eaf7f2a4a96aa4f41ad88b889c8e71"); expect(hash("./tenant-purge-owned-vector-kernel.ts")).toBe("0eabb8e24774af290a89f48ec564c4cf3dbf8f69828eb8c1b83e49ba7abc73ba"); expect(hash("./tenant-purge-owned-schema-kernel.ts")).toBe("26cf6047bb8ccca99979420287abffacc7e96b3cbf5cd341293d221d867e1875");
  });
});
