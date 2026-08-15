import { captureTenantPurgeRootFields } from "./tenant-purge-observation-kernel";

export type TenantPurgeScalarSpec =
  | { readonly kind: "null" | "boolean" | "uuid" | "sha" | "dateIso" | "redactionKey" }
  | { readonly kind: "integer"; readonly minimum: number; readonly maximum: number }
  | { readonly kind: "string"; readonly maximumLength: number };
export type TenantPurgeCompiledScalarSpec = TenantPurgeScalarSpec;
export type TenantPurgeScalarCopy = null | boolean | number | string | readonly number[];

const OBJECT_PROTOTYPE = Object.prototype;
const CREATE = Object.create;
const DEFINE = Object.defineProperty;
const FREEZE = Object.freeze;
const GET_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const GET_PROTOTYPE = Object.getPrototypeOf;
const HAS_OWN = Object.hasOwn;
const SET_PROTOTYPE = Object.setPrototypeOf;
const APPLY = Reflect.apply;
const CONSTRUCT = Reflect.construct;
const OWN_KEYS = Reflect.ownKeys;
const PROXY = Proxy;
const ARRAY = Array;
const ARRAY_PROTOTYPE = Array.prototype;
const STRING = String;
const IS_SAFE_INTEGER = Number.isSafeInteger;
const IS_INTEGER = Number.isInteger;
const IS_FINITE = Number.isFinite;
const REGEXP_EXEC = RegExp.prototype.exec;
const DATE = Date;
const DATE_PROTOTYPE = Date.prototype;
const DATE_GET_TIME = Date.prototype.getTime;
const DATE_TO_ISO = Date.prototype.toISOString;
const UINT8_ARRAY = Uint8Array;
const UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;
const TYPED_ARRAY_PROTOTYPE = GET_PROTOTYPE(UINT8_ARRAY_PROTOTYPE);
const TYPED_ARRAY_TAG = GET_DESCRIPTOR(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)!.get!;
const TYPED_ARRAY_BYTE_LENGTH = GET_DESCRIPTOR(TYPED_ARRAY_PROTOTYPE, "byteLength")!.get!;
const TYPED_ARRAY_BYTE_OFFSET = GET_DESCRIPTOR(TYPED_ARRAY_PROTOTYPE, "byteOffset")!.get!;
const TYPED_ARRAY_BUFFER = GET_DESCRIPTOR(TYPED_ARRAY_PROTOTYPE, "buffer")!.get!;
const ARRAY_BUFFER_PROTOTYPE = ArrayBuffer.prototype;
const ARRAY_BUFFER_BYTE_LENGTH = GET_DESCRIPTOR(ARRAY_BUFFER_PROTOTYPE, "byteLength")!.get!;
const ARRAY_BUFFER_RESIZABLE = GET_DESCRIPTOR(ARRAY_BUFFER_PROTOTYPE, "resizable")!.get!;
const EMPTY = FREEZE([]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ROOT_KEYS = FREEZE(["target", "capabilitySha", "redactionKey", "privateAuthority", "policies", "topology"]);
const SPEC_KEYS = FREEZE({
  bare: FREEZE(["kind"]), integer: FREEZE(["kind", "minimum", "maximum"]), string: FREEZE(["kind", "maximumLength"]),
});
const ABSENT = CREATE(null);

function descriptor(value: unknown): PropertyDescriptor {
  const result = CREATE(null) as PropertyDescriptor;
  result.value = value; result.enumerable = true; result.configurable = true; result.writable = true;
  return result;
}

function record(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = CREATE(null) as Record<string, unknown>;
  const keys = OWN_KEYS(values);
  for (let index = 0; index < keys.length; index += 1) DEFINE(result, keys[index], descriptor(values[keys[index] as string]));
  return result;
}

function root(target: unknown, extra = false): Record<string, unknown> {
  const result = CREATE(null) as Record<string, unknown>;
  for (let index = 0; index < ROOT_KEYS.length; index += 1) DEFINE(result, ROOT_KEYS[index], descriptor(ROOT_KEYS[index] === "target" ? target : ROOT_KEYS[index] === "privateAuthority" ? true : null));
  if (extra) DEFINE(result, "extra", descriptor(true));
  return result;
}

const INVALID_ROOT = FREEZE(root(null, true));

export function observeTenantPurgeValue<T>(operation: () => T): T {
  const target = root(null);
  const handler = CREATE(null) as ProxyHandler<Record<string, unknown>>;
  DEFINE(handler, "getOwnPropertyDescriptor", descriptor((source: Record<string, unknown>, key: PropertyKey) =>
    key === "target" ? descriptor(APPLY(operation, undefined, EMPTY)) : GET_DESCRIPTOR(source, key)));
  const proxy = CONSTRUCT(PROXY, [target, handler]) as Record<string, unknown>;
  return captureTenantPurgeRootFields(proxy).target as T;
}

export function invalidTenantPurgeValue(): never {
  return captureTenantPurgeRootFields(INVALID_ROOT) as never;
}

function valueOf(source: PropertyDescriptor | undefined): unknown | typeof ABSENT {
  return source?.enumerable === true && HAS_OWN(source, "value") ? source.value : ABSENT;
}

function exactKeys(actual: readonly PropertyKey[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < actual.length; index += 1) {
    let found = false;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) if (actual[index] === expected[expectedIndex]) found = true;
    if (!found) return false;
  }
  return true;
}

export function compileTenantPurgeScalarSpec(spec: unknown): TenantPurgeCompiledScalarSpec {
  const kind = valueOf(observeTenantPurgeValue(() => GET_DESCRIPTOR(spec as object, "kind")));
  const expected = kind === "integer" ? SPEC_KEYS.integer : kind === "string" ? SPEC_KEYS.string
    : kind === "null" || kind === "boolean" || kind === "uuid" || kind === "sha" || kind === "dateIso" || kind === "redactionKey" ? SPEC_KEYS.bare : null;
  if (!expected) return invalidTenantPurgeValue();
  const shape = observeTenantPurgeValue(() => record({ prototype: GET_PROTOTYPE(spec as object), keys: OWN_KEYS(spec as object) }));
  if ((shape.prototype !== OBJECT_PROTOTYPE && shape.prototype !== null) || !exactKeys(shape.keys as PropertyKey[], expected)) return invalidTenantPurgeValue();
  const compiled = CREATE(null) as Record<string, unknown>;
  DEFINE(compiled, "kind", descriptor(kind));
  for (let index = 1; index < expected.length; index += 1) {
    const key = expected[index];
    const value = valueOf(observeTenantPurgeValue(() => GET_DESCRIPTOR(spec as object, key)));
    if (value === ABSENT) return invalidTenantPurgeValue();
    DEFINE(compiled, key, descriptor(value));
  }
  if (kind === "integer" && (!IS_SAFE_INTEGER(compiled.minimum) || !IS_INTEGER(compiled.minimum) || !IS_SAFE_INTEGER(compiled.maximum) || !IS_INTEGER(compiled.maximum) || (compiled.minimum as number) > (compiled.maximum as number))) return invalidTenantPurgeValue();
  if (kind === "string" && (!IS_SAFE_INTEGER(compiled.maximumLength) || !IS_INTEGER(compiled.maximumLength) || (compiled.maximumLength as number) < 1 || (compiled.maximumLength as number) > 4096)) return invalidTenantPurgeValue();
  return FREEZE(compiled) as TenantPurgeCompiledScalarSpec;
}

function copyDate(value: unknown): string {
  const observed = observeTenantPurgeValue(() => record({
    prototype: GET_PROTOTYPE(value as object), keys: OWN_KEYS(value as object), milliseconds: APPLY(DATE_GET_TIME, value, EMPTY),
  }));
  if (observed.prototype !== DATE_PROTOTYPE || (observed.keys as PropertyKey[]).length !== 0 || !IS_FINITE(observed.milliseconds)) return invalidTenantPurgeValue();
  return APPLY(DATE_TO_ISO, CONSTRUCT(DATE, [observed.milliseconds]), EMPTY) as string;
}

function copyRedactionKey(value: unknown): readonly number[] {
  const observed = observeTenantPurgeValue(() => {
    const buffer = APPLY(TYPED_ARRAY_BUFFER, value, EMPTY);
    return record({ prototype: GET_PROTOTYPE(value as object), tag: APPLY(TYPED_ARRAY_TAG, value, EMPTY), length: APPLY(TYPED_ARRAY_BYTE_LENGTH, value, EMPTY), byteOffset: APPLY(TYPED_ARRAY_BYTE_OFFSET, value, EMPTY), buffer,
      bufferPrototype: GET_PROTOTYPE(buffer as object), bufferLength: APPLY(ARRAY_BUFFER_BYTE_LENGTH, buffer, EMPTY), resizable: APPLY(ARRAY_BUFFER_RESIZABLE, buffer, EMPTY) });
  });
  const length = observed.length as number;
  if (observed.prototype !== UINT8_ARRAY_PROTOTYPE || observed.tag !== "Uint8Array" || !IS_SAFE_INTEGER(length) || length < 32 || length > 64 || observed.byteOffset !== 0 || observed.bufferPrototype !== ARRAY_BUFFER_PROTOTYPE || observed.resizable !== false || observed.bufferLength !== length) return invalidTenantPurgeValue();
  const keys = observeTenantPurgeValue(() => OWN_KEYS(value as object));
  if (keys.length !== length) return invalidTenantPurgeValue();
  for (let index = 0; index < length; index += 1) if (keys[index] !== STRING(index) || valueOf(observeTenantPurgeValue(() => GET_DESCRIPTOR(value as object, keys[index]))) === ABSENT) return invalidTenantPurgeValue();
  const destination = CONSTRUCT(UINT8_ARRAY, [length]) as Uint8Array;
  APPLY(UINT8_ARRAY_SET, destination, [value]);
  const result = CONSTRUCT(ARRAY, [length]) as number[];
  if (GET_PROTOTYPE(result) !== ARRAY_PROTOTYPE) return invalidTenantPurgeValue();
  SET_PROTOTYPE(result, null);
  for (let index = 0; index < length; index += 1) DEFINE(result, STRING(index), descriptor(valueOf(GET_DESCRIPTOR(destination, STRING(index)))));
  return FREEZE(result);
}

export function copyTenantPurgeScalar(value: unknown, spec: unknown): TenantPurgeScalarCopy {
  const compiled = compileTenantPurgeScalarSpec(spec);
  if (compiled.kind === "null") return value === null ? null : invalidTenantPurgeValue();
  if (compiled.kind === "boolean") return typeof value === "boolean" ? value : invalidTenantPurgeValue();
  if (compiled.kind === "integer") return typeof value === "number" && IS_SAFE_INTEGER(value) && IS_INTEGER(value) && value >= compiled.minimum && value <= compiled.maximum ? value : invalidTenantPurgeValue();
  if (compiled.kind === "string") return typeof value === "string" && value.length <= compiled.maximumLength ? value : invalidTenantPurgeValue();
  if (compiled.kind === "uuid") return typeof value === "string" && value.length === 36 && APPLY(REGEXP_EXEC, UUID_PATTERN, [value]) !== null ? value : invalidTenantPurgeValue();
  if (compiled.kind === "sha") return typeof value === "string" && value.length === 40 && APPLY(REGEXP_EXEC, SHA_PATTERN, [value]) !== null ? value : invalidTenantPurgeValue();
  if (compiled.kind === "dateIso") return copyDate(value);
  return copyRedactionKey(value);
}
