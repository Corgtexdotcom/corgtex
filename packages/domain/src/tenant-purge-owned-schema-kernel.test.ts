import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import * as kernel from "./tenant-purge-owned-schema-kernel";
import { captureTenantPurgeOwnedVector, createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";

const { captureTenantPurgeOwnedSchema: capture, createTenantPurgeOwnedField: field, createTenantPurgeOwnedSchema: create } = kernel;
const call = create as (...values: unknown[]) => kernel.TenantPurgeOwnedSchema;

function caught(operation: () => unknown): AppError {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(AppError); expect(error).toMatchObject({ status: 400, code: "TENANT_PURGE_CONTRACT_INVALID" }); expect(Object.isFrozen(error)).toBe(true); return error as AppError;
  }
  throw new Error("expected failure");
}

function fields(values: readonly (readonly [string, kernel.TenantPurgeOwnedSchema])[], maximum = 64) {
  let vector = createTenantPurgeOwnedVector<kernel.TenantPurgeOwnedField>(maximum);
  for (let index = 0; index < values.length; index += 1) vector = pushTenantPurgeOwnedVector(vector, field(values[index][0], values[index][1]));
  return vector;
}

function record(values: readonly (readonly [string, kernel.TenantPurgeOwnedSchema])[]) { return create("record", fields(values)); }
function manyRecord(count: number, child = create("null")) { return record(Array.from({ length: count }, (_, index) => [`f${index}`, child] as const)); }
function owned(value: object) { expect(Object.getPrototypeOf(value)).toBeNull(); expect(Object.isFrozen(value)).toBe(true); }
function captured<K extends kernel.TenantPurgeOwnedCompiledSchema["kind"]>(schema: unknown, kind: K): Extract<kernel.TenantPurgeOwnedCompiledSchema, { kind: K }> {
  const result = capture(schema); expect(result.kind).toBe(kind); if (result.kind !== kind) throw new Error("unexpected schema kind"); return result as Extract<kernel.TenantPurgeOwnedCompiledSchema, { kind: K }>;
}

describe("tenant purge owned schema kernel", () => {
  it("builds every schema kind as exact immutable kernel data", () => {
    const definitions = [["null"], ["boolean"], ["integer", -2, 3], ["string", 12], ["uuid"], ["sha"], ["dateIso"], ["redactionKey"]] as const;
    const schemas = definitions.map((definition) => call(...definition));
    for (let index = 0; index < schemas.length; index += 1) {
      const state = captured(schemas[index], "scalar"); owned(schemas[index]); owned(state); owned(state.value as object);
      expect(state).toMatchObject({ kind: "scalar", depth: 1, units: 1, primitiveResult: index !== 7 });
      expect((state.value as { kind: string }).kind).toBe(definitions[index][0]); expect(capture(schemas[index])).toBe(state);
    }
    expect(captured(schemas[2], "scalar").value).toMatchObject({ kind: "integer", minimum: -2, maximum: 3 });
    expect(captured(schemas[3], "scalar").value).toMatchObject({ kind: "string", maximumLength: 12 });
    const nullable = create("nullable", schemas[6]); const array = create("array", nullable, 7, true);
    const empty = record([]); const mixed = record([["1", schemas[0]], ["0", array], ["a", empty]]); const state = captured(mixed, "record");
    expect(capture(nullable)).toMatchObject({ kind: "nullable", value: schemas[6], depth: 2, units: 2, primitiveResult: true });
    expect(capture(array)).toMatchObject({ kind: "array", value: nullable, maximumLength: 7, unique: true, depth: 3, units: 3, primitiveResult: false });
    expect(capture(empty)).toMatchObject({ kind: "record", depth: 1, units: 1, primitiveResult: false });
    expect(state).toMatchObject({ kind: "record", depth: 4, units: 9, primitiveResult: false }); owned(state.fields); for (let index = 0; index < state.fields.length; index += 1) owned(state.fields[index]);
    expect([state.fields[0].name, state.fields[1].name, state.fields[2].name]).toEqual(["1", "0", "a"]); expect([state.fields[0].value, state.fields[1].value, state.fields[2].value]).toEqual([schemas[0], array, empty]);
  });

  it("enforces the exact positional grammar without coercion or raw ingress", () => {
    let hooks = 0; const hook = () => { hooks += 1; throw new Error("caller hook"); };
    const hostile = new Proxy({ toString: hook, valueOf: hook, [Symbol.toPrimitive]: hook, [Symbol.iterator]: hook }, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook });
    for (const kind of ["null", "boolean", "uuid", "sha", "dateIso", "redactionKey"] as const) {
      expect(call(kind, undefined, undefined, undefined, hostile)).toBeDefined();
      caught(() => call(kind, null)); caught(() => call(kind, undefined, 0)); caught(() => call(kind, undefined, undefined, false));
    }
    for (const args of [["integer"], ["integer", 0], ["integer", 2, 1], ["integer", 0.5, 2], ["integer", 0, 2, 0], ["string"], ["string", 0], ["string", 4097], ["string", 2, 3]]) caught(() => call(...args));
    const scalar = create("boolean"); const vector = fields([["x", scalar]]);
    for (const args of [[hostile], ["nullable"], ["nullable", hostile], ["nullable", scalar, 0], ["array"], ["array", scalar, -1, false], ["array", scalar, 100_001, false], ["array", scalar, 1.5, false], ["array", scalar, 1, 1], ["record"], ["record", hostile], ["record", vector, 0]]) caught(() => call(...args));
    for (const raw of [{}, [], new Date(0), new Uint8Array(32)]) { caught(() => call("nullable", raw)); caught(() => call("array", raw, 1, false)); caught(() => call("record", raw)); caught(() => field("x", raw)); }
    expect(hooks).toBe(0); expect(caught(() => call(hostile))).not.toBe(caught(() => call(hostile)));
  });

  it("rejects forgeries and cross-kind handles without traps while replaying genuine handles", () => {
    const scalar = create("string", 4); const genuineField = field("x", scalar); const vector = fields([["x", scalar]]); const state = capture(scalar);
    const decorated = Object.create(null); Object.defineProperty(decorated, Symbol("fake"), { value: true });
    for (const fake of [null, 0, "x", {}, Object.freeze({}), Object.create(null), Object.create(scalar), decorated, { ...state }, state, genuineField, vector]) caught(() => capture(fake));
    for (const fake of [vector, state, decorated]) caught(() => field("x", fake));
    for (const fake of [scalar, vector, state, decorated]) caught(() => call("record", pushTenantPurgeOwnedVector(createTenantPurgeOwnedVector(1), fake)));
    const compiledField = captured(create("record", vector), "record").fields[0]; caught(() => field("x", compiledField)); caught(() => call("record", pushTenantPurgeOwnedVector(createTenantPurgeOwnedVector(1), compiledField)));
    let traps = 0; const trap = () => { traps += 1; throw new Error("trap"); };
    const wrapped = new Proxy(scalar as object, { get: trap, has: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    caught(() => capture(wrapped)); caught(() => call("nullable", wrapped)); caught(() => field("x", wrapped));
    const revoked = Proxy.revocable(scalar as object, {}); revoked.revoke(); caught(() => capture(revoked.proxy)); expect(traps).toBe(0);
    const one = create("nullable", scalar); const two = create("array", scalar, 2, true); expect(captured(one, "nullable").value).toBe(scalar); expect(captured(two, "array").value).toBe(scalar);
    caught(() => call("nullable", Object.freeze({ value: scalar }))); expect(capture(scalar)).toBe(state);
  });

  it("bounds fields, rejects duplicates, and preserves integer-like order", () => {
    const scalar = create("null"); caught(() => field("", scalar)); caught(() => field("x".repeat(129), scalar)); caught(() => field({ toString() { throw new Error("coerce"); } }, scalar));
    for (const values of [["a", "a"], ["a", "b", "b"], ["a", "b", "a"]]) caught(() => create("record", fields(values.map((name) => [name, scalar] as const))));
    const sixtyFour = manyRecord(64, scalar); expect(captured(sixtyFour, "record").fields).toHaveLength(64);
    let sixtyFive = createTenantPurgeOwnedVector<kernel.TenantPurgeOwnedField>(65); for (let index = 0; index < 65; index += 1) sixtyFive = pushTenantPurgeOwnedVector(sixtyFive, field(`x${index}`, scalar));
    caught(() => create("record", sixtyFive));
    const ordered = captured(record([["1", scalar], ["0", scalar], ["a", scalar]]), "record"); expect([ordered.fields[0].name, ordered.fields[1].name, ordered.fields[2].name]).toEqual(["1", "0", "a"]);
    expect(Reflect.ownKeys(ordered)).not.toContain("0"); expect(Reflect.ownKeys(ordered.fields)).toEqual(["0", "1", "2", "length"]);
  });

  it("enforces depth and expanded units before registration with no cycle surface", () => {
    let depth = create("null"); for (let index = 1; index < 32; index += 1) depth = create("nullable", depth); expect(capture(depth).depth).toBe(32); caught(() => create("nullable", depth));
    const units129 = manyRecord(64); const units255 = record([...Array.from({ length: 62 }, (_, index) => [`s${index}`, create("null")] as const), ["large", units129]]);
    expect(capture(units129).units).toBe(129); expect(capture(units255).units).toBe(255); const units256 = create("nullable", units255); expect(capture(units256).units).toBe(256); caught(() => create("nullable", units256));
    const units127 = manyRecord(63); expect(capture(record([["once", units127]])).units).toBe(129); caught(() => record([["one", units127], ["two", units127]]));
    caught(() => call("nullable", Object.freeze({ value: undefined }))); caught(() => call("record", fields([["self", Object.create(null) as kernel.TenantPurgeOwnedSchema]])));
  });

  it("allows uniqueness only for primitive-result schemas", () => {
    const primitive = [create("null"), create("boolean"), create("integer", 0, 1), create("string", 2), create("uuid"), create("sha"), create("dateIso")];
    for (const schema of [...primitive, create("nullable", primitive[6])]) expect(captured(create("array", schema, 3, true), "array").unique).toBe(true);
    const redaction = create("redactionKey"); const collection = create("array", primitive[0], 1, false); const object = record([]);
    for (const schema of [redaction, create("nullable", redaction), collection, create("nullable", collection), object, create("nullable", object)]) caught(() => create("array", schema, 1, true));
    for (const schema of [redaction, collection, object]) expect(captured(create("array", schema, 0, false), "array").unique).toBe(false);
  });

  it("uses captured intrinsics under late ambient poisoning", () => {
    const scalar = create("null"); const duplicate = fields([["x", scalar], ["x", scalar]]);
    const original = { Object: globalThis.Object, Reflect: globalThis.Reflect, Number: globalThis.Number, WeakMap: globalThis.WeakMap, Set: globalThis.Set, create: Object.create, define: Object.defineProperty, freeze: Object.freeze, apply: Reflect.apply, safe: Number.isSafeInteger, integer: Number.isInteger, get: WeakMap.prototype.get, set: WeakMap.prototype.set, has: Set.prototype.has, add: Set.prototype.add };
    let valid: kernel.TenantPurgeOwnedSchema | undefined; let first: unknown; let second: unknown;
    try {
      Object.create = (() => { throw new Error("create"); }) as typeof Object.create; Object.defineProperty = (() => { throw new Error("define"); }) as typeof Object.defineProperty; Object.freeze = ((value: unknown) => value) as typeof Object.freeze;
      Reflect.apply = (() => { throw new Error("apply"); }) as typeof Reflect.apply; Number.isSafeInteger = (() => false) as typeof Number.isSafeInteger; Number.isInteger = (() => false) as typeof Number.isInteger;
      WeakMap.prototype.get = (() => { throw new Error("get"); }) as typeof WeakMap.prototype.get; WeakMap.prototype.set = (() => { throw new Error("set"); }) as typeof WeakMap.prototype.set;
      Set.prototype.has = (() => false) as typeof Set.prototype.has; Set.prototype.add = (() => { throw new Error("add"); }) as typeof Set.prototype.add;
      globalThis.WeakMap = function PoisonedWeakMap() { throw new Error("weakmap"); } as unknown as WeakMapConstructor; globalThis.Set = function PoisonedSet() { throw new Error("set"); } as unknown as SetConstructor;
      valid = create("integer", 0, 2); try { create("array", valid, -1, false); } catch (error) { first = error; } try { create("record", duplicate); } catch (error) { second = error; }
    } finally {
      globalThis.Object = original.Object; globalThis.Reflect = original.Reflect; globalThis.Number = original.Number; globalThis.WeakMap = original.WeakMap; globalThis.Set = original.Set;
      original.Object.create = original.create; original.Object.defineProperty = original.define; original.Object.freeze = original.freeze; original.Reflect.apply = original.apply; original.Number.isSafeInteger = original.safe; original.Number.isInteger = original.integer;
      original.WeakMap.prototype.get = original.get; original.WeakMap.prototype.set = original.set; original.Set.prototype.has = original.has; original.Set.prototype.add = original.add;
    }
    expect(capture(valid)).toMatchObject({ kind: "scalar", primitiveResult: true }); for (const error of [first, second]) expect(error).toMatchObject({ status: 400, code: "TENANT_PURGE_CONTRACT_INVALID" }); expect(first).not.toBe(second);
  });

  it("keeps predecessor hashes and runtime/static surface exact", () => {
    expect(Object.keys(kernel).sort()).toEqual(["captureTenantPurgeOwnedSchema", "createTenantPurgeOwnedField", "createTenantPurgeOwnedSchema"]);
    const source = readFileSync(new URL("./tenant-purge-owned-schema-kernel.ts", import.meta.url), "utf8");
    expect(source.match(/^import .*$/gm)).toEqual([
      "import { compileTenantPurgeScalarSpec, invalidTenantPurgeValue, type TenantPurgeCompiledScalarSpec } from \"./tenant-purge-value-scalar-kernel\";",
      "import { captureTenantPurgeOwnedVector, createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector, type TenantPurgeOwnedVector } from \"./tenant-purge-owned-vector-kernel\";",
    ]);
    expect(source).not.toMatch(/ownKeys|Object\.keys|for\s*\([^)]*\sin\s|\bProxy\b|\bDate\b|Uint8Array|\.push\(|\basync\b|topology|target|blocker|provider/);
    const hash = (name: string) => createHash("sha256").update(readFileSync(new URL(name, import.meta.url))).digest("hex");
    expect(hash("./tenant-purge-value-scalar-kernel.ts")).toBe("1fb3bc13f0f033d95880bf908cc578ebf1eaf7f2a4a96aa4f41ad88b889c8e71");
    expect(hash("./tenant-purge-owned-vector-kernel.ts")).toBe("0eabb8e24774af290a89f48ec564c4cf3dbf8f69828eb8c1b83e49ba7abc73ba");
  });
});
