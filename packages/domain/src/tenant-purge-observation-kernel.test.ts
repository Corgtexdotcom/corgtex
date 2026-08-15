import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import * as kernel from "./tenant-purge-observation-kernel";

const { captureTenantPurgeRootFields } = kernel;
const FIELDS = ["target", "capabilitySha", "redactionKey", "privateAuthority", "policies", "topology"] as const;
function input(overrides: Record<string, unknown> = {}) {
  return { target: {}, capabilitySha: "sha", redactionKey: {}, privateAuthority: true, policies: {}, topology: {}, ...overrides };
}
function caught(operation: () => unknown, status = 400, code = status === 400 ? "TENANT_PURGE_CONTRACT_INVALID" : "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED") {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(Object.isFrozen(error)).toBe(true);
    expect(error).toMatchObject({ status, code, message: status === 400 ? "Invalid tenant purge contract input." : "Private tenant purge authority is required." });
    return error as AppError;
  }
  throw new Error("expected failure");
}

describe("tenant purge observation kernel", () => {
  it("observes authority first and captures each authorized root field exactly once", () => {
    const source = input(); const trace: string[] = [];
    const observed = new Proxy(source, {
      get() { throw new Error("getter"); },
      getPrototypeOf(value) { trace.push("prototype"); return Reflect.getPrototypeOf(value); },
      ownKeys(value) { trace.push("keys"); return Reflect.ownKeys(value); },
      getOwnPropertyDescriptor(value, key) { trace.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(value, key); },
    });
    const result = captureTenantPurgeRootFields(observed);
    expect(trace).toEqual(["descriptor:privateAuthority", "prototype", "keys", ...FIELDS.filter((key) => key !== "privateAuthority").map((key) => `descriptor:${key}`)]);
    expect(Object.getPrototypeOf(result)).toBeNull(); expect(result).toEqual(source); expect(Object.isFrozen(result)).toBe(false);
    for (const key of FIELDS) if (key !== "privateAuthority") expect(result[key]).toBe(source[key]);
    expect(Object.keys(kernel)).toEqual(["captureTenantPurgeRootFields"]);
  });

  it("denies every nonliteral authority without protected observation or getter invocation", () => {
    const variants = [input({ privateAuthority: false }), input({ privateAuthority: undefined }), input()];
    delete (variants[1] as { privateAuthority?: unknown }).privateAuthority;
    Object.defineProperty(variants[2]!, "privateAuthority", { value: true, enumerable: false });
    let getterCalls = 0; const accessor = input(); Object.defineProperty(accessor, "privateAuthority", { enumerable: true, get() { getterCalls += 1; return true; } });
    for (const source of [...variants, accessor]) {
      const trace: string[] = [];
      const denied = new Proxy(source, {
        getPrototypeOf() { trace.push("prototype"); throw new Error("protected"); },
        ownKeys() { trace.push("keys"); throw new Error("protected"); },
        getOwnPropertyDescriptor(value, key) { trace.push(String(key)); if (key !== "privateAuthority") throw new Error("protected"); return Reflect.getOwnPropertyDescriptor(value, key); },
      });
      caught(() => captureTenantPurgeRootFields(denied), 403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED"); expect(trace).toEqual(["privateAuthority"]);
    }
    expect(getterCalls).toBe(0);
    expect(caught(() => captureTenantPurgeRootFields(input({ privateAuthority: false })), 403)).not.toBe(caught(() => captureTenantPurgeRootFields(input({ privateAuthority: false })), 403));
  });

  it("rejects root drift, extras, symbols, accessors, and non-plain prototypes without getters", () => {
    let getterCalls = 0; const accessor = input(); Object.defineProperty(accessor, "target", { enumerable: true, get() { getterCalls += 1; return {}; } });
    const hidden = input(); Object.defineProperty(hidden, "hidden", { value: true });
    const symbol = input(); Object.defineProperty(symbol, Symbol("extra"), { value: true });
    const inherited = Object.assign(Object.create({ inherited: true }), input());
    const drift = new Proxy(input(), { getOwnPropertyDescriptor(value, key) { return key === "target" ? undefined : Reflect.getOwnPropertyDescriptor(value, key); } });
    for (const value of [accessor, hidden, symbol, inherited, drift]) caught(() => captureTenantPurgeRootFields(value));
    expect(getterCalls).toBe(0); expect(captureTenantPurgeRootFields(Object.assign(Object.create(null), input()))).toEqual(input());
  });

  it("unconditionally replaces replayed, forged, reentrant, primitive, ordinary, and revoked errors", () => {
    const stale403 = caught(() => captureTenantPurgeRootFields(input({ privateAuthority: false })), 403);
    const stale400 = caught(() => captureTenantPurgeRootFields({ ...input(), extra: true }));
    expect(stale400).not.toBe(caught(() => captureTenantPurgeRootFields({ ...input(), extra: true })));
    const forged = new AppError(200, "FORGED", "forged");
    for (const thrown of [stale403, stale400, forged, new Proxy(forged, {}), new Error("ordinary"), "primitive"]) {
      const hostile = new Proxy(input(), { getOwnPropertyDescriptor(value, key) { if (key === "target") throw thrown; return Reflect.getOwnPropertyDescriptor(value, key); } });
      const replacement = caught(() => captureTenantPurgeRootFields(hostile)); expect(replacement).not.toBe(thrown);
    }
    let nested: AppError | undefined;
    const reentrant = new Proxy(input(), { getOwnPropertyDescriptor(value, key) { if (key === "target") { nested = caught(() => captureTenantPurgeRootFields({ ...input(), extra: true })); throw nested; } return Reflect.getOwnPropertyDescriptor(value, key); } });
    expect(caught(() => captureTenantPurgeRootFields(reentrant))).not.toBe(nested);
    const revoked = Proxy.revocable(input(), {}); revoked.revoke(); caught(() => captureTenantPurgeRootFields(revoked.proxy));
  });

  it("uses captured error, object, reflect, and prototype machinery from early and later traps", () => {
    const originals = {
      Error: globalThis.Error, create: Object.create, define: Object.defineProperty, freeze: Object.freeze, descriptor: Object.getOwnPropertyDescriptor,
      prototype: Object.getPrototypeOf, hasOwn: Object.hasOwn, setPrototype: Object.setPrototypeOf, apply: Reflect.apply, construct: Reflect.construct, keys: Reflect.ownKeys,
    };
    const appErrorSuper = originals.prototype(AppError); const appErrorPrototypeSuper = originals.prototype(AppError.prototype);
    function poison() {
      globalThis.Error = function PoisonedError() { throw "owned"; } as unknown as ErrorConstructor;
      Object.create = (() => { throw "create"; }) as typeof Object.create; Object.defineProperty = (() => { throw "define"; }) as typeof Object.defineProperty;
      Object.freeze = (() => undefined) as unknown as typeof Object.freeze; Object.getOwnPropertyDescriptor = (() => { throw "descriptor"; }) as typeof Object.getOwnPropertyDescriptor;
      Object.getPrototypeOf = (() => { throw "prototype"; }) as typeof Object.getPrototypeOf; Object.hasOwn = (() => false) as typeof Object.hasOwn;
      Object.setPrototypeOf = (() => { throw "setPrototype"; }) as typeof Object.setPrototypeOf; Reflect.apply = (() => { throw "apply"; }) as typeof Reflect.apply;
      Reflect.construct = (() => { throw "construct"; }) as typeof Reflect.construct; Reflect.ownKeys = (() => { throw "keys"; }) as typeof Reflect.ownKeys;
      originals.setPrototype(AppError, () => { throw "super"; }); originals.setPrototype(AppError.prototype, null);
    }
    function restore() {
      globalThis.Error = originals.Error; Object.create = originals.create; Object.defineProperty = originals.define; Object.freeze = originals.freeze;
      Object.getOwnPropertyDescriptor = originals.descriptor; Object.getPrototypeOf = originals.prototype; Object.hasOwn = originals.hasOwn; Object.setPrototypeOf = originals.setPrototype;
      Reflect.apply = originals.apply; Reflect.construct = originals.construct; Reflect.ownKeys = originals.keys;
      originals.setPrototype(AppError, appErrorSuper); originals.setPrototype(AppError.prototype, appErrorPrototypeSuper);
    }
    let early: unknown; try { const denied = new Proxy(input({ privateAuthority: false }), { getOwnPropertyDescriptor(value, key) { poison(); return originals.descriptor(value, key); } }); try { captureTenantPurgeRootFields(denied); } catch (error) { early = error; } } finally { restore(); }
    expect(early).toBeInstanceOf(AppError); expect(early).toMatchObject({ status: 403, code: "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED", message: "Private tenant purge authority is required." }); expect(Object.isFrozen(early)).toBe(true);
    let later: unknown; try { const invalid = new Proxy(input(), { getOwnPropertyDescriptor(value, key) { if (key === "target") { poison(); return undefined; } return originals.descriptor(value, key); } }); try { captureTenantPurgeRootFields(invalid); } catch (error) { later = error; } } finally { restore(); }
    expect(later).toBeInstanceOf(AppError); expect(later).toMatchObject({ status: 400, code: "TENANT_PURGE_CONTRACT_INVALID", message: "Invalid tenant purge contract input." }); expect(Object.isFrozen(later)).toBe(true); expect(later).not.toBe(early);
  });
});
