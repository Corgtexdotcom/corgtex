import { copyTenantPurgeScalar, invalidTenantPurgeValue, type TenantPurgeCompiledScalarSpec, type TenantPurgeScalarCopy } from "./tenant-purge-value-scalar-kernel";
import { captureTenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";
import { captureTenantPurgeOwnedSchema, type TenantPurgeOwnedCompiledSchema } from "./tenant-purge-owned-schema-kernel";

declare const TENANT_PURGE_OWNED_ENTRY: unique symbol;
export type TenantPurgeOwnedEntry = Readonly<{ [TENANT_PURGE_OWNED_ENTRY]: never }>;
export type TenantPurgeOwnedOrderedEntry = readonly [name: string, value: TenantPurgeOwnedCopy];
export type TenantPurgeOwnedCopy =
  | TenantPurgeScalarCopy
  | readonly TenantPurgeOwnedCopy[]
  | readonly TenantPurgeOwnedOrderedEntry[];

interface EntryState { readonly name: string; readonly value: unknown }
interface CopyContext { usedSlots: number; readonly active: Set<unknown> }

const CREATE = Object.create;
const DEFINE = Object.defineProperty;
const FREEZE = Object.freeze;
const SET_PROTOTYPE = Object.setPrototypeOf;
const APPLY = Reflect.apply;
const CONSTRUCT = Reflect.construct;
const ARRAY = Array;
const IS_SAFE_INTEGER = Number.isSafeInteger;
const IS_INTEGER = Number.isInteger;
const DATE = Date;
const UINT8_ARRAY = Uint8Array;
const WEAK_MAP = WeakMap;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const SET = Set;
const SET_HAS = Set.prototype.has;
const SET_ADD = Set.prototype.add;
const SET_DELETE = Set.prototype.delete;
const ENTRIES = new WEAK_MAP<object, EntryState>();
const EMPTY = FREEZE([]);
const MAXIMUM_SLOTS = 100_000;
const MAXIMUM_DATE = 8_640_000_000_000_000;

function invalid(): never { return invalidTenantPurgeValue(); }

function descriptor(value: unknown): PropertyDescriptor {
  const result = CREATE(null) as PropertyDescriptor;
  result.value = value; result.enumerable = true; result.configurable = true; result.writable = true;
  return result;
}

function frozenRecord<T>(entries: readonly (readonly [PropertyKey, unknown])[]): T {
  const result = CREATE(null) as Record<PropertyKey, unknown>;
  for (let index = 0; index < entries.length; index += 1) DEFINE(result, entries[index][0], descriptor(entries[index][1]));
  return FREEZE(result) as T;
}

function entryState(value: unknown): EntryState {
  return (APPLY(WEAK_MAP_GET, ENTRIES, [value]) as EntryState | undefined) ?? invalid();
}

function reserve(context: CopyContext, count: number): void {
  if (count > MAXIMUM_SLOTS - context.usedSlots) invalid();
  context.usedSlots += count;
}

function remaining(context: CopyContext): number {
  return MAXIMUM_SLOTS - context.usedSlots;
}

function list(length: number): unknown[] {
  const result = CONSTRUCT(ARRAY, [length]) as unknown[];
  SET_PROTOTYPE(result, null);
  return result;
}

function withVector<T>(value: unknown, maximum: number, context: CopyContext): readonly T[] {
  if (APPLY(SET_HAS, context.active, [value])) return invalid();
  APPLY(SET_ADD, context.active, [value]);
  return captureTenantPurgeOwnedVector<T>(value, maximum);
}

function releaseVector(value: unknown, context: CopyContext): void {
  APPLY(SET_DELETE, context.active, [value]);
}

function copyScalar(value: unknown, spec: TenantPurgeCompiledScalarSpec): TenantPurgeScalarCopy {
  if (spec.kind === "dateIso") {
    if (typeof value !== "number" || !IS_SAFE_INTEGER(value) || !IS_INTEGER(value)
      || value < -MAXIMUM_DATE || value > MAXIMUM_DATE) return invalid();
    return copyTenantPurgeScalar(CONSTRUCT(DATE, [value]), spec);
  }
  return copyTenantPurgeScalar(value, spec);
}

function copyRedaction(value: unknown, spec: TenantPurgeCompiledScalarSpec, context: CopyContext): TenantPurgeScalarCopy {
  const limit = remaining(context) < 64 ? remaining(context) : 64;
  const input = withVector<number>(value, limit, context);
  if (input.length < 32 || input.length > 64) return invalid();
  reserve(context, input.length);
  const bytes = CONSTRUCT(UINT8_ARRAY, [input.length]) as Uint8Array;
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!IS_SAFE_INTEGER(item) || !IS_INTEGER(item) || item < 0 || item > 255) return invalid();
    DEFINE(bytes, index, descriptor(item));
  }
  const output = copyTenantPurgeScalar(bytes, spec);
  releaseVector(value, context);
  return output;
}

function copyValue(value: unknown, schema: TenantPurgeOwnedCompiledSchema, depth: number, context: CopyContext): TenantPurgeOwnedCopy {
  if (depth > 32) return invalid();
  if (schema.kind === "scalar") {
    return schema.value.kind === "redactionKey"
      ? copyRedaction(value, schema.value, context)
      : copyScalar(value, schema.value);
  }
  if (schema.kind === "nullable") {
    return value === null ? null : copyValue(value, captureTenantPurgeOwnedSchema(schema.value), depth + 1, context);
  }
  if (schema.kind === "array") {
    const child = captureTenantPurgeOwnedSchema(schema.value);
    const bound = schema.maximumLength < remaining(context) ? schema.maximumLength : remaining(context);
    const input = withVector<unknown>(value, bound, context);
    reserve(context, input.length);
    const output = list(input.length);
    const seen = schema.unique ? CONSTRUCT(SET, EMPTY) as Set<unknown> : null;
    for (let index = 0; index < input.length; index += 1) {
      const copied = copyValue(input[index], child, depth + 1, context);
      if (seen && APPLY(SET_HAS, seen, [copied])) return invalid();
      if (seen) APPLY(SET_ADD, seen, [copied]);
      DEFINE(output, index, descriptor(copied));
    }
    releaseVector(value, context);
    return FREEZE(output) as readonly TenantPurgeOwnedCopy[];
  }
  const fields = schema.fields;
  reserve(context, fields.length * 3);
  const input = withVector<TenantPurgeOwnedEntry>(value, fields.length, context);
  if (input.length !== fields.length) return invalid();
  for (let index = 0; index < fields.length; index += 1) {
    if (entryState(input[index]).name !== fields[index].name) return invalid();
  }
  const output = list(fields.length);
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const state = entryState(input[index]);
    const tuple = list(2);
    DEFINE(tuple, 0, descriptor(field.name));
    DEFINE(tuple, 1, descriptor(copyValue(state.value, captureTenantPurgeOwnedSchema(field.value), depth + 1, context)));
    DEFINE(output, index, descriptor(FREEZE(tuple)));
  }
  releaseVector(value, context);
  return FREEZE(output) as readonly TenantPurgeOwnedOrderedEntry[];
}

export function createTenantPurgeOwnedEntry(name: unknown, value: unknown): TenantPurgeOwnedEntry {
  if (typeof name !== "string" || name.length < 1 || name.length > 128) return invalid();
  const handle = FREEZE(CREATE(null)) as TenantPurgeOwnedEntry;
  const state = frozenRecord<EntryState>([["name", name], ["value", value]]);
  APPLY(WEAK_MAP_SET, ENTRIES, [handle, state]);
  return handle;
}

export function copyTenantPurgeOwnedCollection(value: unknown, schema: unknown): TenantPurgeOwnedCopy {
  const compiled = captureTenantPurgeOwnedSchema(schema);
  const context = CREATE(null) as CopyContext;
  DEFINE(context, "usedSlots", descriptor(0));
  DEFINE(context, "active", descriptor(CONSTRUCT(SET, EMPTY)));
  return copyValue(value, compiled, 1, context);
}
