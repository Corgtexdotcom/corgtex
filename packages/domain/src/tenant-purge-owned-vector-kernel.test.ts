import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import * as kernel from "./tenant-purge-owned-vector-kernel";

const { captureTenantPurgeOwnedVector, createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector } = kernel;

function caught(operation: () => unknown): AppError {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(AppError); expect(error).toMatchObject({ status: 400, code: "TENANT_PURGE_CONTRACT_INVALID" }); expect(Object.isFrozen(error)).toBe(true); return error as AppError;
  }
  throw new Error("expected failure");
}

describe("tenant purge owned vector kernel", () => {
  it("bounds allocation and captures exactly 100000 items iteratively", () => {
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 100_001]) {
      caught(() => createTenantPurgeOwnedVector(value)); caught(() => captureTenantPurgeOwnedVector({}, value));
    }
    const zero = createTenantPurgeOwnedVector(0); caught(() => pushTenantPurgeOwnedVector(zero, 0));
    let vector = createTenantPurgeOwnedVector<number>(100_000);
    for (let index = 0; index < 100_000; index += 1) vector = pushTenantPurgeOwnedVector(vector, index);
    const captured = captureTenantPurgeOwnedVector<number>(vector, 100_000);
    expect(captured).toHaveLength(100_000); expect(captured[0]).toBe(0); expect(captured[99_999]).toBe(99_999);
    expect(Object.getPrototypeOf(captured)).toBeNull(); expect(Object.isFrozen(captured)).toBe(true);
    caught(() => pushTenantPurgeOwnedVector(vector, 100_000)); caught(() => captureTenantPurgeOwnedVector(vector, 99_999));
  }, 20_000);

  it("preserves dense order, persistence, capacity, and detached containers", () => {
    const empty = createTenantPurgeOwnedVector<string>(3); const one = pushTenantPurgeOwnedVector(empty, "a");
    const two = pushTenantPurgeOwnedVector(one, "b"); const three = pushTenantPurgeOwnedVector(two, "c");
    expect(captureTenantPurgeOwnedVector(empty, 3)).toHaveLength(0); expect(captureTenantPurgeOwnedVector(one, 3)[0]).toBe("a");
    const snapshot = captureTenantPurgeOwnedVector(three, 3);
    expect([snapshot[0], snapshot[1], snapshot[2]]).toEqual(["a", "b", "c"]); expect(Reflect.ownKeys(snapshot)).toEqual(["0", "1", "2", "length"]);
    for (let index = 0; index < snapshot.length; index += 1) {
      expect(Object.hasOwn(snapshot, index)).toBe(true); expect(Object.getOwnPropertyDescriptor(snapshot, index)).toMatchObject({ enumerable: true, configurable: false, writable: false });
    }
    expect(() => { (snapshot as string[])[0] = "changed"; }).toThrow();
    const later = captureTenantPurgeOwnedVector(three, 3);
    expect(later).not.toBe(snapshot); expect(later[0]).toBe("a");
    const branch = pushTenantPurgeOwnedVector(one, "x");
    expect(captureTenantPurgeOwnedVector(branch, 3)[1]).toBe("x"); expect(captureTenantPurgeOwnedVector(two, 3)[1]).toBe("b");
    const limited = pushTenantPurgeOwnedVector(createTenantPurgeOwnedVector(1), "z"); caught(() => pushTenantPurgeOwnedVector(limited, "overflow"));
    caught(() => pushTenantPurgeOwnedVector(three, "overflow"));
  });

  it("authenticates exact propertyless handles without caller traps", () => {
    const genuine = createTenantPurgeOwnedVector(2);
    expect(Object.getPrototypeOf(genuine)).toBeNull(); expect(Reflect.ownKeys(genuine)).toEqual([]); expect(Object.isFrozen(genuine)).toBe(true);
    const inherited = Object.create(genuine); const decorated = Object.create(null);
    Object.defineProperty(decorated, Symbol("fake"), { value: true }); const copied = Object.assign(Object.create(null), genuine);
    for (const fake of [null, undefined, 0, "fake", Symbol("fake"), {}, Object.freeze({}), Object.create(null), inherited, decorated, copied]) {
      caught(() => pushTenantPurgeOwnedVector(fake, 1)); caught(() => captureTenantPurgeOwnedVector(fake, 2));
    }
    let traps = 0; const trap = () => { traps += 1; throw new Error("caller trap"); };
    const wrapped = new Proxy(genuine as object, {
      get: trap, set: trap, has: trap, ownKeys: trap, getPrototypeOf: trap,
      setPrototypeOf: trap, getOwnPropertyDescriptor: trap, defineProperty: trap,
      deleteProperty: trap, isExtensible: trap, preventExtensions: trap,
    });
    caught(() => pushTenantPurgeOwnedVector(wrapped, 1)); caught(() => captureTenantPurgeOwnedVector(wrapped, 2)); caught(() => captureTenantPurgeOwnedVector(wrapped, -1));
    const revoked = Proxy.revocable(genuine as object, {}); revoked.revoke(); caught(() => captureTenantPurgeOwnedVector(revoked.proxy, 2));
    expect(traps).toBe(0);
  });

  it("transports item identity without reading, reflecting, coercing, or calling it", () => {
    let hooks = 0; const trap = () => { hooks += 1; throw new Error("item observed"); };
    const target = Object.create(null);
    Object.defineProperties(target, {
      accessor: { get: trap }, toJSON: { value: trap }, [Symbol.iterator]: { value: trap }, [Symbol.toPrimitive]: { value: trap },
    });
    const item = new Proxy(target, {
      get: trap, set: trap, has: trap, ownKeys: trap, getPrototypeOf: trap,
      setPrototypeOf: trap, getOwnPropertyDescriptor: trap, defineProperty: trap,
      deleteProperty: trap, isExtensible: trap, preventExtensions: trap,
    });
    const vector = pushTenantPurgeOwnedVector(createTenantPurgeOwnedVector(1), item); const captured = captureTenantPurgeOwnedVector(vector, 1);
    expect(captured[0]).toBe(item); expect(hooks).toBe(0);
  });

  it("uses captured intrinsics and bypasses poisoned prototype hooks", () => {
    const original = {
      Object: globalThis.Object, Reflect: globalThis.Reflect, Array: globalThis.Array, Number: globalThis.Number, WeakMap: globalThis.WeakMap,
      create: Object.create, define: Object.defineProperty, freeze: Object.freeze, setPrototype: Object.setPrototypeOf, apply: Reflect.apply,
      safe: Number.isSafeInteger, get: WeakMap.prototype.get, set: WeakMap.prototype.set, zero: Object.getOwnPropertyDescriptor(Object.prototype, "0"),
      toJSON: Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"),
    };
    let setterCalls = 0; let jsonCalls = 0;
    let output: readonly string[] | undefined; let first: unknown; let second: unknown;
    try {
      original.define(Object.prototype, "0", { configurable: true, set() { setterCalls += 1; } });
      original.define(Object.prototype, "toJSON", { configurable: true, value() { jsonCalls += 1; } });
      Object.create = (() => { throw new Error("create"); }) as typeof Object.create; Object.defineProperty = (() => { throw new Error("define"); }) as typeof Object.defineProperty;
      Object.freeze = ((value: unknown) => value) as typeof Object.freeze;
      Object.setPrototypeOf = (() => { throw new Error("prototype"); }) as typeof Object.setPrototypeOf; Reflect.apply = (() => { throw new Error("apply"); }) as typeof Reflect.apply;
      Number.isSafeInteger = (() => false) as typeof Number.isSafeInteger; WeakMap.prototype.get = (() => { throw new Error("get"); }) as typeof WeakMap.prototype.get;
      WeakMap.prototype.set = (() => { throw new Error("set"); }) as typeof WeakMap.prototype.set;
      globalThis.Array = function PoisonedArray() { throw new Error("array"); } as unknown as ArrayConstructor; globalThis.WeakMap = function PoisonedWeakMap() { throw new Error("weakmap"); } as unknown as WeakMapConstructor;
      let vector = createTenantPurgeOwnedVector<string>(2); vector = pushTenantPurgeOwnedVector(vector, "a");
      output = captureTenantPurgeOwnedVector(vector, 2);
      try { captureTenantPurgeOwnedVector({}, 2); } catch (error) { first = error; }
      try { createTenantPurgeOwnedVector(-1); } catch (error) { second = error; }
    } finally {
      globalThis.Object = original.Object; globalThis.Reflect = original.Reflect; globalThis.Array = original.Array; globalThis.Number = original.Number; globalThis.WeakMap = original.WeakMap;
      original.Object.create = original.create; original.Object.defineProperty = original.define;
      original.Object.freeze = original.freeze; original.Object.setPrototypeOf = original.setPrototype;
      original.Reflect.apply = original.apply; original.Number.isSafeInteger = original.safe;
      original.WeakMap.prototype.get = original.get; original.WeakMap.prototype.set = original.set;
      if (original.zero) original.define(original.Object.prototype, "0", original.zero);
      else delete (original.Object.prototype as Record<string, unknown>)["0"];
      if (original.toJSON) original.define(original.Object.prototype, "toJSON", original.toJSON);
      else delete (original.Object.prototype as Record<string, unknown>).toJSON;
    }
    expect(output?.[0]).toBe("a"); expect(Object.getPrototypeOf(output)).toBeNull(); expect(Object.isFrozen(output)).toBe(true);
    expect(setterCalls).toBe(0); expect(jsonCalls).toBe(0);
    for (const error of [first, second]) { expect(error).toBeInstanceOf(AppError); expect(error).toMatchObject({ status: 400, code: "TENANT_PURGE_CONTRACT_INVALID" }); }
    expect(first).not.toBe(second);
  });

  it("keeps the runtime and static source surface exact", () => {
    expect(Object.keys(kernel).sort()).toEqual(["captureTenantPurgeOwnedVector", "createTenantPurgeOwnedVector", "pushTenantPurgeOwnedVector"]);
    const source = readFileSync(new URL("./tenant-purge-owned-vector-kernel.ts", import.meta.url), "utf8");
    expect(source.match(/^import .*$/gm)).toEqual(["import { invalidTenantPurgeValue } from \"./tenant-purge-value-scalar-kernel\";"]);
    expect(source).not.toMatch(/ownKeys|Object\.keys|for\s*\([^)]*\sin\s|\bProxy\b|\bSet\b|\basync\b|topology|target|blocker|provider/);
  });
});
