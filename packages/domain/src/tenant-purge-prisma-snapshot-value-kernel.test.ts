import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "./errors";
import {
  captureTenantPurgeOwnedVector,
  createTenantPurgeOwnedVector,
  pushTenantPurgeOwnedVector,
  type TenantPurgeOwnedVector,
} from "./tenant-purge-owned-vector-kernel";
import * as kernel from "./tenant-purge-prisma-snapshot-value-kernel";

const {
  captureTenantPurgePrismaClockMilliseconds: clock,
  captureTenantPurgePrismaDateMilliseconds: date,
  captureTenantPurgePrismaOrderedUuidVector: ids,
  captureTenantPurgePrismaRowValues: row,
} = kernel;

function vector<T>(values: readonly T[], maximum = values.length): TenantPurgeOwnedVector<T> {
  let result = createTenantPurgeOwnedVector<T>(maximum);
  for (let index = 0; index < values.length; index += 1) {
    result = pushTenantPurgeOwnedVector(result, values[index]);
  }
  return result;
}

function captured<T>(value: TenantPurgeOwnedVector<T>, maximum: number): readonly T[] {
  return captureTenantPurgeOwnedVector(value, maximum);
}

function caught(operation: () => unknown): AppError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 400, code: "TENANT_PURGE_CONTRACT_INVALID" });
    expect(Object.isFrozen(error)).toBe(true);
    return error as AppError;
  }
  throw new Error("expected failure");
}

const uuid = (tail: number) => `123e4567-e89b-12d3-a456-${String(tail).padStart(12, "0")}`;

describe("tenant purge Prisma snapshot value kernel", () => {
  it("captures row descriptors once in owned spec order without observing extras", () => {
    const selected = Object.create(null); let extras = 0; const trace: PropertyKey[] = [];
    const source = { beta: selected, alpha: "a" };
    Object.defineProperties(source, {
      extra: { enumerable: true, get() { extras += 1; return "extra"; } },
      toJSON: { get() { extras += 1; return () => null; } },
    });
    const wrapped = new Proxy(source, {
      getOwnPropertyDescriptor(target, key) {
        trace.push(key); return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const output = captured(row(wrapped, vector(["alpha", "beta"])), 2);
    expect([output[0], output[1]]).toEqual(["a", selected]);
    expect(trace).toEqual(["alpha", "beta"]); expect(extras).toBe(0);
    expect(Object.getPrototypeOf(output)).toBeNull(); expect(Object.isFrozen(output)).toBe(true);
    source.alpha = "changed"; expect(output[0]).toBe("a"); expect(output).not.toBe(source);
    const nullRow = Object.assign(Object.create(null), { id: "detached" });
    expect(captured(row(nullRow, vector(["id"])), 1)[0]).toBe("detached");
  });

  it("rejects forged, unbounded, duplicate, or unsafe field specifications", () => {
    const unsafe = [vector([]), vector(["a", "a"]), vector(["0bad"]), vector(["bad-name"]),
      vector(["x".repeat(129)]), vector(Array.from({ length: 33 }, (_, index) => `f${index}`))];
    for (const fields of unsafe) caught(() => row({}, fields));
    for (const fields of [{}, Object.freeze(Object.create(null))]) {
      caught(() => row({}, fields as TenantPurgeOwnedVector<string>));
    }
    let traps = 0; const genuine = vector(["id"]);
    const proxy = new Proxy(genuine as object, { get() { traps += 1; throw new Error("trap"); } });
    caught(() => row({}, proxy as TenantPurgeOwnedVector<string>)); expect(traps).toBe(0);
  });

  it("rejects hostile row shapes and replaces caller failures without running getters", () => {
    for (const value of [null, 1, [], new Date(), Object.create({ inherited: true })]) {
      caught(() => row(value, vector(["id"])));
    }
    let getters = 0; const accessor = {};
    Object.defineProperty(accessor, "id", { enumerable: true, get() { getters += 1; return "x"; } });
    const hidden = {}; Object.defineProperty(hidden, "id", { value: "x" });
    for (const value of [{}, accessor, hidden]) caught(() => row(value, vector(["id"])));
    expect(getters).toBe(0);
    const callerError = new Error("caller");
    const trapped = new Proxy({}, { getOwnPropertyDescriptor() { throw callerError; } });
    const first = caught(() => row(trapped, vector(["id"])));
    const second = caught(() => row(trapped, vector(["id"])));
    expect(first).not.toBe(callerError); expect(second).not.toBe(first);
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    caught(() => row(revoked.proxy, vector(["id"])));
  });

  it("bounds canonical array length before observing indexes", () => {
    const trace: PropertyKey[] = [];
    const tooMany = new Proxy(new Array(1_001), {
      getOwnPropertyDescriptor(target, key) {
        trace.push(key); return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    caught(() => ids(tooMany)); expect(trace).toEqual(["length"]);
    for (const descriptor of [
      { value: -1, writable: true, enumerable: false, configurable: false },
      { value: Number.MAX_SAFE_INTEGER + 1, writable: true, enumerable: false, configurable: false },
      { get: () => 1, enumerable: false, configurable: false },
    ]) {
      const seen: PropertyKey[] = [];
      const hostile = new Proxy([], { getOwnPropertyDescriptor(target, key) {
        seen.push(key); return key === "length" ? descriptor : Reflect.getOwnPropertyDescriptor(target, key);
      } });
      caught(() => ids(hostile)); expect(seen).toEqual(["length"]);
    }
  });

  it("captures zero, one, and one thousand strictly ordered UUID rows", () => {
    expect(captured(ids([]), 0)).toEqual([]);
    expect(captured(ids([{ id: uuid(1) }]), 1)[0]).toBe(uuid(1));
    const thousand = Array.from({ length: 1_000 }, (_, index) => ({ id: uuid(index) }));
    const output = captured(ids(thousand), 1_000);
    expect(output).toHaveLength(1_000); expect(output[0]).toBe(uuid(0));
    expect(output[999]).toBe(uuid(999)); expect(Object.getPrototypeOf(output)).toBeNull();
    expect(Object.isFrozen(output)).toBe(true);
  });

  it("rejects sparse, accessor, malformed, duplicate, and descending UUID rows", () => {
    const sparse = new Array(1); const hidden = [{ id: uuid(1) }];
    Object.defineProperty(hidden, "0", { value: hidden[0], enumerable: false });
    let getters = 0; const accessor = [{ id: uuid(1) }];
    Object.defineProperty(accessor, "0", { enumerable: true, get() { getters += 1; return {}; } });
    const bad = [sparse, hidden, accessor, [{}], [{ id: "bad" }],
      [{ id: uuid(1) }, { id: uuid(1) }], [{ id: uuid(2) }, { id: uuid(1) }]];
    for (const value of bad) caught(() => ids(value)); expect(getters).toBe(0);
  });

  it("ignores iteration, inherited setters, and extra or symbol getters", () => {
    let hooks = 0; const input = [{ id: uuid(1) }];
    Object.defineProperties(input, {
      extra: { get() { hooks += 1; throw new Error("extra"); } },
      [Symbol("extra")]: { get() { hooks += 1; throw new Error("symbol"); } },
      [Symbol.iterator]: { value() { hooks += 1; throw new Error("iterate"); } },
    });
    const zero = Object.getOwnPropertyDescriptor(Object.prototype, "0");
    Object.defineProperty(Object.prototype, "0", { configurable: true, set() { hooks += 1; } });
    try { expect(captured(ids(input), 1)[0]).toBe(uuid(1)); } finally {
      if (zero) Object.defineProperty(Object.prototype, "0", zero);
      else delete (Object.prototype as Record<string, unknown>)["0"];
    }
    expect(hooks).toBe(0);
  });

  it("accepts exact Dates and rejects invalid, forged, subclassed, or proxied values", () => {
    expect(date(new Date(0))).toBe(0); expect(date(new Date(8_640_000_000_000_000))).toBe(8_640_000_000_000_000);
    class Child extends Date {}
    const forged = Object.create(Date.prototype); const revoked = Proxy.revocable(new Date(), {}); revoked.revoke();
    for (const value of [new Date(Number.NaN), new Child(), forged, new DataView(new ArrayBuffer(1)),
      new Proxy(new Date(), {}), revoked.proxy]) caught(() => date(value));
    let extras = 0; const decorated = new Date(7);
    Object.defineProperty(decorated, "extra", { get() { extras += 1; throw new Error("extra"); } });
    expect(date(decorated)).toBe(7); expect(extras).toBe(0);
  });

  it("uses captured clock, Date, descriptor, numeric, and string intrinsics", async () => {
    const now = Date.now; const time = Date.prototype.getTime; const descriptor = Object.getOwnPropertyDescriptor;
    const prototype = Object.getPrototypeOf; const hasOwn = Object.hasOwn; const isArray = Array.isArray;
    const safe = Number.isSafeInteger; const apply = Reflect.apply; const stringify = globalThis.String;
    const stringPrototype = String.prototype; const charCodeAt = stringPrototype.charCodeAt;
    let output: readonly unknown[] | undefined; let instant: number | undefined;
    let capturedClock: number | undefined;
    const source = { id: "ok" }; const fields = vector(["id"]); const exactDate = new Date(9);
    try {
      Date.now = () => { throw new Error("now"); }; Date.prototype.getTime = () => { throw new Error("time"); };
      Object.getOwnPropertyDescriptor = () => { throw new Error("descriptor"); };
      Object.getPrototypeOf = () => { throw new Error("prototype"); }; Object.hasOwn = () => false;
      Array.isArray = ((value: unknown): value is unknown[] => false) as typeof Array.isArray;
      Number.isSafeInteger = () => false;
      Reflect.apply = () => { throw new Error("apply"); }; globalThis.String = (() => "poison") as StringConstructor;
      stringPrototype.charCodeAt = () => -1; output = captured(row(source, fields), 1);
      instant = date(exactDate); capturedClock = clock();
    } finally {
      Date.now = now; Date.prototype.getTime = time; Object.getOwnPropertyDescriptor = descriptor;
      Object.getPrototypeOf = prototype; Object.hasOwn = hasOwn; Array.isArray = isArray;
      Number.isSafeInteger = safe; Reflect.apply = apply; globalThis.String = stringify;
      stringPrototype.charCodeAt = charCodeAt;
    }
    expect(output?.[0]).toBe("ok"); expect(instant).toBe(9); expect(capturedClock).toBeTypeOf("number");
    vi.resetModules(); const savedNow = Date.now; Date.now = () => Number.NaN;
    let isolated: typeof kernel;
    try { isolated = await import("./tenant-purge-prisma-snapshot-value-kernel"); } finally { Date.now = savedNow; }
    expect(() => isolated.captureTenantPurgePrismaClockMilliseconds()).toThrowError();
  });

  it("keeps exact exports, arities, imports, and forbidden surfaces", () => {
    expect(Object.keys(kernel).sort()).toEqual([
      "captureTenantPurgePrismaClockMilliseconds", "captureTenantPurgePrismaDateMilliseconds",
      "captureTenantPurgePrismaOrderedUuidVector", "captureTenantPurgePrismaRowValues",
    ]);
    expect([clock.length, date.length, ids.length, row.length]).toEqual([0, 1, 1, 2]);
    const source = readFileSync(new URL("./tenant-purge-prisma-snapshot-value-kernel.ts", import.meta.url), "utf8");
    const barrel = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(barrel).not.toContain("tenant-purge-prisma-snapshot-value-kernel");
    expect(source).not.toMatch(/Reflect\.ownKeys|Object\.keys|for\s*\([^)]*\sof\s|\basync\b/);
    expect(source).not.toMatch(/@corgtex\/shared|\bPrisma\b|queryRaw|executeRaw|transaction|\block\b/);
    expect(source).not.toContain("tenant-purge-prisma-snapshot-adapter");
  });
});
