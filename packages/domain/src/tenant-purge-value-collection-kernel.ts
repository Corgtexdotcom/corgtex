import {
  compileTenantPurgeScalarSpec,
  copyTenantPurgeScalar,
  invalidTenantPurgeValue,
  observeTenantPurgeValue,
  type TenantPurgeCompiledScalarSpec,
  type TenantPurgeScalarCopy,
} from "./tenant-purge-value-scalar-kernel";

export type TenantPurgeStructuredCopy =
  | TenantPurgeScalarCopy
  | { readonly [key: string]: TenantPurgeStructuredCopy }
  | readonly TenantPurgeStructuredCopy[];

type CompiledNode =
  | { readonly kind: "scalar"; readonly value: TenantPurgeCompiledScalarSpec }
  | { readonly kind: "nullable"; readonly value: CompiledNode }
  | { readonly kind: "record"; readonly fields: readonly CompiledField[] }
  | { readonly kind: "array"; readonly value: CompiledNode; readonly maximumLength: number; readonly unique: boolean };
type CompiledField = { readonly name: string; readonly value: CompiledNode };
type CompileContext = { units: number; readonly active: Set<unknown> };
type CopyContext = { slots: number; readonly active: Set<unknown> };

const OBJECT_PROTOTYPE = Object.prototype;
const CREATE = Object.create;
const DEFINE = Object.defineProperty;
const FREEZE = Object.freeze;
const GET_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const GET_PROTOTYPE = Object.getPrototypeOf;
const HAS_OWN = Object.hasOwn;
const SET_OBJECT_PROTOTYPE = Object.setPrototypeOf;
const APPLY = Reflect.apply;
const CONSTRUCT = Reflect.construct;
const OWN_KEYS = Reflect.ownKeys;
const ARRAY = Array;
const ARRAY_PROTOTYPE = Array.prototype;
const IS_ARRAY = Array.isArray;
const IS_SAFE_INTEGER = Number.isSafeInteger;
const IS_INTEGER = Number.isInteger;
const STRING = String;
const SET = Set;
const SET_HAS = Set.prototype.has;
const SET_ADD = Set.prototype.add;
const SET_DELETE = Set.prototype.delete;
const EMPTY = FREEZE([]);
const ABSENT = CREATE(null);
const MAX_DEPTH = 32;
const MAX_SCHEMA_UNITS = 256;
const MAX_FIELDS = 64;
const MAX_SLOTS = 100_000;
const NODE_KEYS = FREEZE({
  scalar: FREEZE(["kind", "value"]), nullable: FREEZE(["kind", "value"]),
  record: FREEZE(["kind", "fields"]), array: FREEZE(["kind", "value", "maximumLength", "unique"]),
});
const ENTRY_KEYS = FREEZE(["name", "value"]);

function observed<T>(operation: () => T): T { return observeTenantPurgeValue(operation); }
function descriptor(value: unknown, enumerable = true): PropertyDescriptor {
  const result = CREATE(null) as PropertyDescriptor;
  result.value = value; result.enumerable = enumerable; result.configurable = true; result.writable = true;
  return result;
}
function define(target: object, key: PropertyKey, value: unknown): void { DEFINE(target, key, descriptor(value)); }
function dataValue(source: PropertyDescriptor | undefined, enumerable = true): unknown | typeof ABSENT {
  return source?.enumerable === enumerable && HAS_OWN(source, "value") ? source.value : ABSENT;
}
function exactKeys(actual: readonly PropertyKey[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < actual.length; index += 1) {
    let found = false;
    for (let candidate = 0; candidate < expected.length; candidate += 1) if (actual[index] === expected[candidate]) found = true;
    if (!found) return false;
  }
  return true;
}
function canonicalArrayKeys(actual: readonly PropertyKey[], length: number): boolean {
  if (actual.length !== length + 1) return false;
  for (let index = 0; index < length; index += 1) if (actual[index] !== STRING(index)) return false;
  return actual[length] === "length";
}
function genuineSet(): Set<unknown> { return CONSTRUCT(SET, EMPTY) as Set<unknown>; }
function has(set: Set<unknown>, value: unknown): boolean { return APPLY(SET_HAS, set, [value]) as boolean; }
function add(set: Set<unknown>, value: unknown): void { APPLY(SET_ADD, set, [value]); }
function remove(set: Set<unknown>, value: unknown): void { APPLY(SET_DELETE, set, [value]); }
function list(length: number): unknown[] {
  const result = CONSTRUCT(ARRAY, [length]) as unknown[];
  if (GET_PROTOTYPE(result) !== ARRAY_PROTOTYPE) return invalidTenantPurgeValue();
  SET_OBJECT_PROTOTYPE(result, null);
  return result;
}
function node(kind: string, values: readonly (readonly [string, unknown])[]): CompiledNode {
  const result = CREATE(null) as Record<string, unknown>; define(result, "kind", kind);
  for (let index = 0; index < values.length; index += 1) define(result, values[index][0], values[index][1]);
  return FREEZE(result) as CompiledNode;
}

function compile(raw: unknown, depth: number, context: CompileContext): CompiledNode {
  if (depth > MAX_DEPTH || context.units + 1 > MAX_SCHEMA_UNITS || has(context.active, raw)) return invalidTenantPurgeValue();
  context.units += 1; add(context.active, raw);
  try {
    const kind = dataValue(observed(() => GET_DESCRIPTOR(raw as object, "kind")));
    const expected = kind === "scalar" ? NODE_KEYS.scalar : kind === "nullable" ? NODE_KEYS.nullable : kind === "record" ? NODE_KEYS.record : kind === "array" ? NODE_KEYS.array : null;
    if (!expected) return invalidTenantPurgeValue();
    const prototype = observed(() => GET_PROTOTYPE(raw as object));
    const keys = observed(() => OWN_KEYS(raw as object));
    if ((prototype !== OBJECT_PROTOTYPE && prototype !== null) || !exactKeys(keys, expected)) return invalidTenantPurgeValue();
    const captured = list(expected.length - 1);
    for (let index = 1; index < expected.length; index += 1) {
      const value = dataValue(observed(() => GET_DESCRIPTOR(raw as object, expected[index])));
      if (value === ABSENT) return invalidTenantPurgeValue();
      define(captured, STRING(index - 1), value);
    }
    if (kind === "scalar") return node("scalar", [["value", compileTenantPurgeScalarSpec(captured[0])]]);
    if (kind === "nullable") return node("nullable", [["value", compile(captured[0], depth + 1, context)]]);
    if (kind === "array") {
      const maximumLength = captured[1]; const unique = captured[2];
      if (!IS_SAFE_INTEGER(maximumLength) || !IS_INTEGER(maximumLength) || (maximumLength as number) < 0 || (maximumLength as number) > MAX_SLOTS || typeof unique !== "boolean") return invalidTenantPurgeValue();
      const child = compile(captured[0], depth + 1, context);
      if (unique && !primitiveResult(child)) return invalidTenantPurgeValue();
      return node("array", [["value", child], ["maximumLength", maximumLength], ["unique", unique]]);
    }
    return compileRecord(captured[0], depth, context);
  } finally { remove(context.active, raw); }
}

function compileRecord(rawFields: unknown, depth: number, context: CompileContext): CompiledNode {
  const length = dataValue(observed(() => GET_DESCRIPTOR(rawFields as object, "length")), false);
  if (!IS_SAFE_INTEGER(length) || !IS_INTEGER(length) || (length as number) < 0 || (length as number) > MAX_FIELDS || context.units + (length as number) > MAX_SCHEMA_UNITS) return invalidTenantPurgeValue();
  context.units += length as number;
  if (!IS_ARRAY(rawFields) || !canonicalArrayKeys(observed(() => OWN_KEYS(rawFields as object)), length as number)) return invalidTenantPurgeValue();
  const prototype = observed(() => GET_PROTOTYPE(rawFields as object));
  if (prototype !== ARRAY_PROTOTYPE && prototype !== null) return invalidTenantPurgeValue();
  const entries = list(length as number);
  for (let index = 0; index < (length as number); index += 1) {
    const entry = dataValue(observed(() => GET_DESCRIPTOR(rawFields as object, STRING(index))));
    if (entry === ABSENT) return invalidTenantPurgeValue(); define(entries, STRING(index), entry);
  }
  const names = list(length as number); const children = list(length as number); const seen = genuineSet();
  for (let index = 0; index < (length as number); index += 1) {
    const entry = entries[index]; const prototype = observed(() => GET_PROTOTYPE(entry as object)); const keys = observed(() => OWN_KEYS(entry as object));
    if ((prototype !== OBJECT_PROTOTYPE && prototype !== null) || !exactKeys(keys, ENTRY_KEYS)) return invalidTenantPurgeValue();
    const name = dataValue(observed(() => GET_DESCRIPTOR(entry as object, "name")));
    const child = dataValue(observed(() => GET_DESCRIPTOR(entry as object, "value")));
    if (typeof name !== "string" || name.length < 1 || name.length > 128 || child === ABSENT || has(seen, name)) return invalidTenantPurgeValue();
    add(seen, name); define(names, STRING(index), name); define(children, STRING(index), child);
  }
  const compiled = list(length as number);
  for (let index = 0; index < (length as number); index += 1) {
    const field = CREATE(null) as Record<string, unknown>; define(field, "name", names[index]); define(field, "value", compile(children[index], depth + 1, context)); define(compiled, STRING(index), FREEZE(field));
  }
  return node("record", [["fields", FREEZE(compiled)]]);
}

function primitiveResult(spec: CompiledNode): boolean {
  return spec.kind === "scalar" ? spec.value.kind !== "redactionKey" : spec.kind === "nullable" ? primitiveResult(spec.value) : false;
}
function enter(context: CopyContext, value: unknown): void {
  if (has(context.active, value)) return invalidTenantPurgeValue(); add(context.active, value);
}
function reserve(context: CopyContext, count: number): void {
  if (context.slots + count > MAX_SLOTS) return invalidTenantPurgeValue(); context.slots += count;
}
function copy(value: unknown, spec: CompiledNode, depth: number, context: CopyContext): TenantPurgeStructuredCopy {
  if (depth > MAX_DEPTH) return invalidTenantPurgeValue();
  if (spec.kind === "scalar") return copyTenantPurgeScalar(value, spec.value);
  if (spec.kind === "nullable") return value === null ? null : copy(value, spec.value, depth + 1, context);
  enter(context, value);
  try {
    if (spec.kind === "record") return copyRecord(value, spec.fields, depth, context);
    return copyArray(value, spec, depth, context);
  } finally { remove(context.active, value); }
}
function copyRecord(value: unknown, fields: readonly CompiledField[], depth: number, context: CopyContext): TenantPurgeStructuredCopy {
  reserve(context, fields.length);
  const prototype = observed(() => GET_PROTOTYPE(value as object)); const keys = observed(() => OWN_KEYS(value as object)); const names = list(fields.length);
  for (let index = 0; index < fields.length; index += 1) define(names, STRING(index), fields[index].name);
  if ((prototype !== OBJECT_PROTOTYPE && prototype !== null) || !exactKeys(keys, names as string[])) return invalidTenantPurgeValue();
  const captured = list(fields.length);
  for (let index = 0; index < fields.length; index += 1) {
    const item = dataValue(observed(() => GET_DESCRIPTOR(value as object, fields[index].name)));
    if (item === ABSENT) return invalidTenantPurgeValue(); define(captured, STRING(index), item);
  }
  const result = CREATE(null) as Record<string, TenantPurgeStructuredCopy>;
  for (let index = 0; index < fields.length; index += 1) define(result, fields[index].name, copy(captured[index], fields[index].value, depth + 1, context));
  return FREEZE(result);
}
function copyArray(value: unknown, spec: Extract<CompiledNode, { kind: "array" }>, depth: number, context: CopyContext): TenantPurgeStructuredCopy {
  const length = dataValue(observed(() => GET_DESCRIPTOR(value as object, "length")), false);
  if (!IS_SAFE_INTEGER(length) || !IS_INTEGER(length) || (length as number) < 0 || (length as number) > spec.maximumLength || (length as number) > MAX_SLOTS) return invalidTenantPurgeValue();
  reserve(context, length as number);
  if (!IS_ARRAY(value)) return invalidTenantPurgeValue();
  const prototype = observed(() => GET_PROTOTYPE(value as object)); const keys = observed(() => OWN_KEYS(value as object));
  if ((prototype !== ARRAY_PROTOTYPE && prototype !== null) || !canonicalArrayKeys(keys, length as number)) return invalidTenantPurgeValue();
  const captured = list(length as number);
  for (let index = 0; index < (length as number); index += 1) {
    const item = dataValue(observed(() => GET_DESCRIPTOR(value as object, STRING(index))));
    if (item === ABSENT) return invalidTenantPurgeValue(); define(captured, STRING(index), item);
  }
  const result = list(length as number); const seen = spec.unique ? genuineSet() : null;
  for (let index = 0; index < (length as number); index += 1) {
    const item = copy(captured[index], spec.value, depth + 1, context);
    if (seen) { if (has(seen, item)) return invalidTenantPurgeValue(); add(seen, item); }
    define(result, STRING(index), item);
  }
  return FREEZE(result) as TenantPurgeStructuredCopy;
}

export function copyTenantPurgeStructuredValue(value: unknown, spec: unknown): TenantPurgeStructuredCopy {
  return observed(() => {
    const compiled = compile(spec, 1, { units: 0, active: genuineSet() });
    return copy(value, compiled, 1, { slots: 0, active: genuineSet() });
  });
}
