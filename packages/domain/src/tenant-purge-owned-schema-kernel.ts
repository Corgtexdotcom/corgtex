import { compileTenantPurgeScalarSpec, invalidTenantPurgeValue, type TenantPurgeCompiledScalarSpec } from "./tenant-purge-value-scalar-kernel";
import { captureTenantPurgeOwnedVector, createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector, type TenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";

declare const TENANT_PURGE_OWNED_SCHEMA: unique symbol;
declare const TENANT_PURGE_OWNED_FIELD: unique symbol;
export type TenantPurgeOwnedSchema = Readonly<{ [TENANT_PURGE_OWNED_SCHEMA]: never }>;
export type TenantPurgeOwnedField = Readonly<{ [TENANT_PURGE_OWNED_FIELD]: never }>;
export type TenantPurgeOwnedSchemaKind = "null" | "boolean" | "integer" | "string" | "uuid" | "sha" | "dateIso" | "redactionKey" | "nullable" | "array" | "record";
export type TenantPurgeOwnedCompiledField = Readonly<{ name: string; value: TenantPurgeOwnedSchema }>;
export type TenantPurgeOwnedCompiledSchema =
  | Readonly<{ kind: "scalar"; value: TenantPurgeCompiledScalarSpec; depth: 1; units: 1; primitiveResult: boolean }>
  | Readonly<{ kind: "nullable"; value: TenantPurgeOwnedSchema; depth: number; units: number; primitiveResult: boolean }>
  | Readonly<{ kind: "array"; value: TenantPurgeOwnedSchema; maximumLength: number; unique: boolean; depth: number; units: number; primitiveResult: false }>
  | Readonly<{ kind: "record"; fields: readonly TenantPurgeOwnedCompiledField[]; depth: number; units: number; primitiveResult: false }>;

const CREATE = Object.create;
const DEFINE = Object.defineProperty;
const FREEZE = Object.freeze;
const APPLY = Reflect.apply;
const IS_SAFE_INTEGER = Number.isSafeInteger;
const IS_INTEGER = Number.isInteger;
const WEAK_MAP = WeakMap;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const SET = Set;
const SET_HAS = Set.prototype.has;
const SET_ADD = Set.prototype.add;
const SCHEMAS = new WEAK_MAP<object, TenantPurgeOwnedCompiledSchema>();
const FIELDS = new WEAK_MAP<object, TenantPurgeOwnedCompiledField>();

function invalid(): never { return invalidTenantPurgeValue(); }

function frozen<T>(entries: readonly (readonly [PropertyKey, unknown])[]): T {
  const result = CREATE(null) as Record<PropertyKey, unknown>;
  for (let index = 0; index < entries.length; index += 1) DEFINE(result, entries[index][0], { value: entries[index][1], enumerable: true, configurable: true, writable: true });
  return FREEZE(result) as T;
}

function schemaState(value: unknown): TenantPurgeOwnedCompiledSchema {
  return (APPLY(WEAK_MAP_GET, SCHEMAS, [value]) as TenantPurgeOwnedCompiledSchema | undefined) ?? invalid();
}

function fieldState(value: unknown): TenantPurgeOwnedCompiledField {
  return (APPLY(WEAK_MAP_GET, FIELDS, [value]) as TenantPurgeOwnedCompiledField | undefined) ?? invalid();
}

function registerSchema(state: TenantPurgeOwnedCompiledSchema): TenantPurgeOwnedSchema {
  const handle = FREEZE(CREATE(null)) as TenantPurgeOwnedSchema;
  APPLY(WEAK_MAP_SET, SCHEMAS, [handle, state]);
  return handle;
}

function bounded(depth: number, units: number): void {
  if (depth > 32 || units > 256) invalid();
}

function scalar(kind: TenantPurgeOwnedSchemaKind, primary: unknown, secondary: unknown): TenantPurgeOwnedSchema {
  const spec = kind === "integer" ? frozen([["kind", kind], ["minimum", primary], ["maximum", secondary]])
    : kind === "string" ? frozen([["kind", kind], ["maximumLength", primary]]) : frozen([["kind", kind]]);
  const value = compileTenantPurgeScalarSpec(spec);
  return registerSchema(frozen([["kind", "scalar"], ["value", value], ["depth", 1], ["units", 1], ["primitiveResult", kind !== "redactionKey"]]));
}

export function createTenantPurgeOwnedSchema(kind: TenantPurgeOwnedSchemaKind, primary?: unknown, secondary?: unknown, tertiary?: unknown): TenantPurgeOwnedSchema {
  if (kind === "null" || kind === "boolean" || kind === "uuid" || kind === "sha" || kind === "dateIso" || kind === "redactionKey") {
    if (primary !== undefined || secondary !== undefined || tertiary !== undefined) return invalid();
    return scalar(kind, undefined, undefined);
  }
  if (kind === "integer" || kind === "string") {
    if ((kind === "integer" ? secondary === undefined : secondary !== undefined) || tertiary !== undefined) return invalid();
    return scalar(kind, primary, secondary);
  }
  if (kind === "nullable") {
    if (secondary !== undefined || tertiary !== undefined) return invalid();
    const child = schemaState(primary); const depth = child.depth + 1; const units = child.units + 1; bounded(depth, units);
    return registerSchema(frozen([["kind", kind], ["value", primary], ["depth", depth], ["units", units], ["primitiveResult", child.primitiveResult]]));
  }
  if (kind === "array") {
    if (!IS_SAFE_INTEGER(secondary) || !IS_INTEGER(secondary) || (secondary as number) < 0 || (secondary as number) > 100_000 || typeof tertiary !== "boolean") return invalid();
    const child = schemaState(primary); if (tertiary && !child.primitiveResult) return invalid();
    const depth = child.depth + 1; const units = child.units + 1; bounded(depth, units);
    return registerSchema(frozen([["kind", kind], ["value", primary], ["maximumLength", secondary], ["unique", tertiary], ["depth", depth], ["units", units], ["primitiveResult", false]]));
  }
  if (kind !== "record" || secondary !== undefined || tertiary !== undefined) return invalid();
  const input = captureTenantPurgeOwnedVector<TenantPurgeOwnedField>(primary, 64);
  let output: TenantPurgeOwnedVector<TenantPurgeOwnedCompiledField> = createTenantPurgeOwnedVector(64);
  const names = new SET<string>(); let depth = 1; let units = 1;
  for (let index = 0; index < input.length; index += 1) {
    const field = fieldState(input[index]); const child = schemaState(field.value);
    const nextDepth = child.depth + 1; const nextUnits = units + child.units + 1; bounded(nextDepth, nextUnits);
    if (APPLY(SET_HAS, names, [field.name])) return invalid();
    APPLY(SET_ADD, names, [field.name]); depth = nextDepth > depth ? nextDepth : depth; units = nextUnits;
    output = pushTenantPurgeOwnedVector(output, field);
  }
  return registerSchema(frozen([["kind", kind], ["fields", captureTenantPurgeOwnedVector(output, 64)], ["depth", depth], ["units", units], ["primitiveResult", false]]));
}

export function createTenantPurgeOwnedField(name: unknown, schema: unknown): TenantPurgeOwnedField {
  if (typeof name !== "string" || name.length < 1 || name.length > 128) return invalid();
  schemaState(schema);
  const state = frozen<TenantPurgeOwnedCompiledField>([["name", name], ["value", schema]]);
  const handle = FREEZE(CREATE(null)) as TenantPurgeOwnedField;
  APPLY(WEAK_MAP_SET, FIELDS, [handle, state]);
  return handle;
}

export function captureTenantPurgeOwnedSchema(schema: unknown): TenantPurgeOwnedCompiledSchema {
  return schemaState(schema);
}
