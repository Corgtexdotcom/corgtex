import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import * as kernel from "./tenant-purge-value-collection-kernel";

const { copyTenantPurgeStructuredValue: copy } = kernel;
const text = { kind: "string", maximumLength: 128 } as const;
const scalar = (value: unknown) => ({ kind: "scalar", value });
const array = (value: unknown, maximumLength = 100_000, unique = false) => ({ kind: "array", value, maximumLength, unique });
const record = (fields: unknown[]) => ({ kind: "record", fields });
const field = (name: string, value: unknown) => ({ name, value });
function caught(operation: () => unknown) {
  try { operation(); } catch (error) { expect(error).toBeInstanceOf(AppError); expect(error).toMatchObject({ status: 400, code: "TENANT_PURGE_CONTRACT_INVALID" }); expect(Object.isFrozen(error)).toBe(true); return error as AppError; }
  throw new Error("expected failure");
}

describe("tenant purge value collection kernel", () => {
  it("copies a detached deeply frozen null-prototype graph in declared order", () => {
    const child = record([field("id", scalar(text))]); const bytes = new Uint8Array(32); bytes[0] = 7; const when = new Date("2026-08-15T00:00:00.000Z"); const shared = { id: "same" };
    const spec = record([field("title", scalar(text)), field("maybe", { kind: "nullable", value: scalar({ kind: "uuid" }) }), field("when", scalar({ kind: "dateIso" })), field("keys", array(scalar({ kind: "redactionKey" }), 1)), field("a", child), field("b", child)]);
    const source = { title: "before", maybe: null, when, keys: [bytes], a: shared, b: shared }; const result = copy(source, spec) as Record<string, unknown>;
    source.title = "after"; when.setTime(0); bytes[0] = 99; (spec.fields[0] as { name: string }).name = "owned";
    expect(Reflect.ownKeys(result)).toEqual(["title", "maybe", "when", "keys", "a", "b"]); expect(result).toMatchObject({ title: "before", maybe: null, when: "2026-08-15T00:00:00.000Z" });
    const keys = result.keys as readonly (readonly number[])[]; expect(keys[0][0]).toBe(7); expect(result.a).not.toBe(result.b);
    for (const value of [result, keys, keys[0], result.a, result.b]) { expect(Object.getPrototypeOf(value)).toBeNull(); expect(Object.isFrozen(value)).toBe(true); }
  });

  it("rejects inexact schema shapes, descriptors, names, bounds, budgets, depth, and cycles before getters", () => {
    let getters = 0; const accessor = {}; Object.defineProperty(accessor, "kind", { enumerable: true, get() { getters += 1; return "scalar"; } });
    const hidden = { kind: "scalar", value: text }; Object.defineProperty(hidden, "extra", { value: true }); const symbol = { kind: "scalar", value: text, [Symbol("x")]: true };
    const drifting = new Proxy({ kind: "scalar", value: text }, { getOwnPropertyDescriptor(target, key) { return key === "value" ? undefined : Reflect.getOwnPropertyDescriptor(target, key); } });
    const fieldAccessor = [field("x", scalar(text))]; Object.defineProperty(fieldAccessor, "0", { enumerable: true, get() { getters += 1; return field("x", scalar(text)); } }); const fieldDrift = new Proxy([field("x", scalar(text))], { getOwnPropertyDescriptor(target, key) { return key === "0" ? undefined : Reflect.getOwnPropertyDescriptor(target, key); } });
    const entryAccessor = field("x", scalar(text)); Object.defineProperty(entryAccessor, "value", { enumerable: true, get() { getters += 1; return scalar(text); } }); const entryDrift = new Proxy(field("x", scalar(text)), { getOwnPropertyDescriptor(target, key) { return key === "value" ? undefined : Reflect.getOwnPropertyDescriptor(target, key); } });
    const hiddenFields = [field("x", scalar(text))]; Object.defineProperty(hiddenFields, "extra", { value: true });
    for (const spec of [accessor, hidden, symbol, {}, { kind: "record" }, Object.assign(Object.create({}), { kind: "scalar", value: text }), drifting, record(fieldAccessor), record(fieldDrift), record([entryAccessor]), record([entryDrift]), record(hiddenFields), record([field("", scalar(text))]), record([field("x".repeat(129), scalar(text))]), record([field("x", scalar(text)), field("x", scalar(text))]), array(scalar(text), -1), array(scalar(text), 100_001), { kind: "array", value: scalar(text), maximumLength: 1, unique: 1 }, array(scalar({ kind: "redactionKey" }), 1, true), array(record([]), 1, true), record(Array.from({ length: 65 }, (_, index) => field(String(index), scalar(text))))]) caught(() => copy(null, spec));
    const broad = record(Array.from({ length: 64 }, (_, index) => field(String(index), record([field("v", scalar(text))])))); caught(() => copy(null, broad));
    let deep: unknown = scalar(text); for (let index = 0; index < 33; index += 1) deep = { kind: "nullable", value: deep }; caught(() => copy(null, deep));
    const cycle: Record<string, unknown> = { kind: "nullable" }; cycle.value = cycle; caught(() => copy(null, cycle)); expect(getters).toBe(0);
  });

  it("rejects first, middle, and last holes plus accessors and hidden extras without invoking getters", () => {
    const spec = array(scalar(text), 3); const holes = [new Array(3), ["a", , "c"], ["a", "b", ,]]; holes[0][1] = "b";
    for (const value of holes) caught(() => copy(value, spec)); let getters = 0; const accessor = ["a"]; Object.defineProperty(accessor, "0", { enumerable: true, get() { getters += 1; return "a"; } });
    const hidden = ["a"]; Object.defineProperty(hidden, "extra", { value: true }); const symbol = ["a"]; Object.defineProperty(symbol, Symbol("x"), { value: true });
    for (const value of [accessor, hidden, symbol]) caught(() => copy(value, spec)); expect(getters).toBe(0);
  });

  it("validates every record descriptor before descending into an earlier sibling", () => {
    let nested = 0; let late = 0; const early = new Proxy({ id: "ok" }, { getPrototypeOf(target) { nested += 1; return Reflect.getPrototypeOf(target); } }); const source = { early };
    Object.defineProperty(source, "late", { enumerable: true, get() { late += 1; return "owned"; } });
    caught(() => copy(source, record([field("early", record([field("id", scalar(text))])), field("late", scalar(text))]))); expect(nested).toBe(0); expect(late).toBe(0);
  });

  it("bounds lengths and the invocation slot budget before protected traversal or allocation", () => {
    caught(() => copy(new Array(2 ** 32 - 1), array(scalar(text)))); let protectedCalls = 0;
    const huge = new Proxy(Object.defineProperty({}, "length", { value: Number.MAX_SAFE_INTEGER }), { getPrototypeOf() { protectedCalls += 1; throw "prototype"; }, ownKeys() { protectedCalls += 1; throw "keys"; } }); caught(() => copy(huge, array(scalar(text)))); expect(protectedCalls).toBe(0);
    caught(() => copy(["a", "b"], array(scalar(text), 1))); let innerKeys = 0; const inner = new Proxy(Array.from({ length: 100_000 }, () => "x"), { ownKeys(target) { innerKeys += 1; return Reflect.ownKeys(target); } }); caught(() => copy([inner], array(array(scalar(text), 100_000), 1))); expect(innerKeys).toBe(0);
    const cyclic: unknown[] = []; cyclic[0] = cyclic; caught(() => copy(cyclic, array(array(scalar(text), 1), 1)));
  });

  it("requires exact ordered canonical array keys before any index descriptor", () => {
    const spec = array(scalar(text), 2); const invalid: unknown[] = [];
    for (const key of ["01", "-0", "1e0", "3"]) { const value = ["a"]; Object.defineProperty(value, key, { value: "x", enumerable: true, configurable: true }); invalid.push(value); }
    invalid.push(new Proxy(["a"], { ownKeys() { return ["0", "1", "length"]; }, getOwnPropertyDescriptor(target, key) { return key === "1" ? { value: "x", enumerable: true, configurable: true, writable: true } : Reflect.getOwnPropertyDescriptor(target, key); } }));
    invalid.push([, "b"], ["a", ,], Object.assign(["a"], { [Symbol("x")]: true }), new Proxy(["a"], { ownKeys() { return ["length", "0"]; } }));
    for (const value of invalid) caught(() => copy(value, spec)); let indices = 0; const beforeDescriptors = new Proxy(Object.assign(["a"], { "01": "x" }), { getOwnPropertyDescriptor(target, key) { if (key !== "length") indices += 1; return Reflect.getOwnPropertyDescriptor(target, key); } }); caught(() => copy(beforeDescriptors, spec)); expect(indices).toBe(0);
    expect(copy(["a", "b"], spec)).toEqual(["a", "b"]);
  });

  it("uses own definition and null prototypes despite inherited setters and toJSON hooks", () => {
    const recordSetter = Object.getOwnPropertyDescriptor(Object.prototype, "safe"); const arraySetter = Object.getOwnPropertyDescriptor(Array.prototype, "0"); const objectJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"); const arrayJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON"); let hooks = 0;
    Object.defineProperty(Object.prototype, "safe", { configurable: true, set() { hooks += 1; } }); Object.defineProperty(Array.prototype, "0", { configurable: true, set() { hooks += 1; } }); Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value() { hooks += 1; return "owned"; } }); Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value() { hooks += 1; return "owned"; } });
    try { const result = copy({ safe: ["ok"] }, record([field("safe", array(scalar(text), 1))])) as Record<string, unknown>; expect(JSON.stringify(result)).toBe('{"safe":["ok"]}'); expect((Object.getOwnPropertyDescriptor(result, "safe")?.value as readonly string[])[0]).toBe("ok"); expect(Object.getOwnPropertyDescriptor(result.safe, "0")).toMatchObject({ value: "ok", enumerable: true }); expect(hooks).toBe(0); } finally { for (const [target, key, saved] of [[Object.prototype, "safe", recordSetter], [Array.prototype, "0", arraySetter], [Object.prototype, "toJSON", objectJson], [Array.prototype, "toJSON", arrayJson]] as const) { if (saved) Object.defineProperty(target, key, saved); else delete (target as Record<string, unknown>)[key]; } }
  });

  it("uses captured genuine Sets linearly through 100000 items and rejects early or late duplicates", () => {
    const spec = array(scalar({ kind: "integer", minimum: 0, maximum: 100_000 }), 100_000, true); const values = Array.from({ length: 100_000 }, (_, index) => index); expect(copy(values, spec)).toHaveLength(100_000); expect(copy([null, "123e4567-e89b-12d3-a456-426614174000"], array({ kind: "nullable", value: scalar({ kind: "uuid" }) }, 2, true))).toHaveLength(2); expect(copy([new Date(0), new Date(1)], array(scalar({ kind: "dateIso" }), 2, true))).toEqual(["1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.001Z"]);
    const early = values.slice(); early[1] = 0; const late = values.slice(); late[99_999] = 0; caught(() => copy(early, spec)); caught(() => copy(late, spec));
    const originals = { Set: globalThis.Set, has: Set.prototype.has, add: Set.prototype.add, delete: Set.prototype.delete }; const poison = () => { globalThis.Set = function() { throw "set"; } as unknown as SetConstructor; originals.Set.prototype.has = () => false; originals.Set.prototype.add = function() { return this; }; originals.Set.prototype.delete = () => true; };
    const restore = () => { globalThis.Set = originals.Set; originals.Set.prototype.has = originals.has; originals.Set.prototype.add = originals.add; originals.Set.prototype.delete = originals.delete; }; const trapped = new Proxy(spec, { getOwnPropertyDescriptor(target, key) { if (key === "kind") poison(); return Object.getOwnPropertyDescriptor(target, key); } }); try { expect(copy([1, 2], trapped)).toEqual([1, 2]); caught(() => copy([1, 1], spec)); } finally { restore(); } const latePoisoned = new Proxy([1, 2], { getOwnPropertyDescriptor(target, key) { if (key === "length") poison(); return originals.Set === globalThis.Set ? Reflect.getOwnPropertyDescriptor(target, key) : Object.getOwnPropertyDescriptor(target, key); } }); try { expect(copy(latePoisoned, spec)).toEqual([1, 2]); } finally { restore(); }
  }, 20_000);

  it("normalizes hostile failures, survives captured intrinsic poisoning, and exports one runtime value", () => {
    const stale = caught(() => copy([], {})); const forged = new AppError(403, "FORGED", "forged"); const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const thrown of [stale, forged, "primitive", new Error("ordinary")]) { const hostile = new Proxy({ kind: "scalar", value: text }, { getOwnPropertyDescriptor(target, key) { if (key === "value") throw thrown; return Reflect.getOwnPropertyDescriptor(target, key); } }); expect(caught(() => copy("ok", hostile))).not.toBe(thrown); } caught(() => copy("ok", revoked.proxy)); let nested: unknown; const reentrant = new Proxy({ kind: "scalar", value: text }, { getOwnPropertyDescriptor(target, key) { if (key === "value") { nested = caught(() => copy([], {})); throw nested; } return Reflect.getOwnPropertyDescriptor(target, key); } }); expect(caught(() => copy("ok", reentrant))).not.toBe(nested);
    const originals = { Object: globalThis.Object, Reflect: globalThis.Reflect, Array: globalThis.Array, Number: globalThis.Number, String: globalThis.String, Set: globalThis.Set, create: Object.create, define: Object.defineProperty, freeze: Object.freeze, descriptor: Object.getOwnPropertyDescriptor, prototype: Object.getPrototypeOf, hasOwn: Object.hasOwn, setPrototype: Object.setPrototypeOf, apply: Reflect.apply, construct: Reflect.construct, keys: Reflect.ownKeys, isArray: Array.isArray, safe: Number.isSafeInteger, integer: Number.isInteger };
    const poison = () => { Object.create = (() => { throw "create"; }) as typeof Object.create; Object.defineProperty = (() => { throw "define"; }) as typeof Object.defineProperty; Object.freeze = (() => undefined) as unknown as typeof Object.freeze; Object.getOwnPropertyDescriptor = (() => { throw "descriptor"; }) as typeof Object.getOwnPropertyDescriptor; Object.getPrototypeOf = (() => { throw "prototype"; }) as typeof Object.getPrototypeOf; Object.hasOwn = (() => false) as typeof Object.hasOwn; Object.setPrototypeOf = (() => { throw "setPrototype"; }) as typeof Object.setPrototypeOf; Reflect.apply = (() => { throw "apply"; }) as typeof Reflect.apply; Reflect.construct = (() => { throw "construct"; }) as typeof Reflect.construct; Reflect.ownKeys = (() => { throw "keys"; }) as typeof Reflect.ownKeys; Array.isArray = (() => false) as unknown as typeof Array.isArray; Number.isSafeInteger = (() => false) as typeof Number.isSafeInteger; Number.isInteger = (() => false) as typeof Number.isInteger; originals.Object.assign(globalThis, { Object: function() { throw "object"; }, Reflect: {}, Array: function() { throw "array"; }, Number: function() { throw "number"; }, String: function() { throw "string"; }, Set: function() { throw "set"; } }); };
    const trapped = new Proxy(array(scalar(text), 2), { getOwnPropertyDescriptor(target, key) { if (key === "kind") poison(); return originals.descriptor(target, key); } }); let survived: unknown; try { survived = copy(["a"], trapped); } finally { originals.Object.assign(globalThis, { Object: originals.Object, Reflect: originals.Reflect, Array: originals.Array, Number: originals.Number, String: originals.String, Set: originals.Set }); Object.create = originals.create; Object.defineProperty = originals.define; Object.freeze = originals.freeze; Object.getOwnPropertyDescriptor = originals.descriptor; Object.getPrototypeOf = originals.prototype; Object.hasOwn = originals.hasOwn; Object.setPrototypeOf = originals.setPrototype; Reflect.apply = originals.apply; Reflect.construct = originals.construct; Reflect.ownKeys = originals.keys; Array.isArray = originals.isArray; Number.isSafeInteger = originals.safe; Number.isInteger = originals.integer; } expect(survived).toEqual(["a"]);
    expect(Object.keys(kernel)).toEqual(["copyTenantPurgeStructuredValue"]);
  });
});
