import {
  compileTenantPurgeScalarSpec,
  copyTenantPurgeScalar,
  invalidTenantPurgeValue,
  observeTenantPurgeValue,
} from "./tenant-purge-value-scalar-kernel";
import {
  captureTenantPurgeOwnedVector,
  createTenantPurgeOwnedVector,
  pushTenantPurgeOwnedVector,
  type TenantPurgeOwnedVector,
} from "./tenant-purge-owned-vector-kernel";

const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_PROTOTYPE = Array.prototype;
const CREATE = Object.create;
const GET_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const GET_PROTOTYPE = Object.getPrototypeOf;
const HAS_OWN = Object.hasOwn;
const DEFINE = Object.defineProperty;
const FREEZE = Object.freeze;
const APPLY = Reflect.apply;
const ARRAY_IS_ARRAY = Array.isArray;
const STRING = String;
const CHAR_CODE_AT = String.prototype.charCodeAt;
const IS_SAFE_INTEGER = Number.isSafeInteger;
const DATE = Date;
const DATE_PROTOTYPE = Date.prototype;
const DATE_GET_TIME = Date.prototype.getTime;
const DATE_NOW = Date.now;
const EMPTY = FREEZE([]);
const MAXIMUM_FIELDS = 32;
const MAXIMUM_FIELD_NAME_LENGTH = 128;
const MAXIMUM_ROWS = 1_000;

function invalid(): never {
  return invalidTenantPurgeValue();
}

const RAW_UUID_SPEC = CREATE(null);
DEFINE(RAW_UUID_SPEC, "kind", { value: "uuid", enumerable: true });
const UUID_SPEC = compileTenantPurgeScalarSpec(RAW_UUID_SPEC);
let ID_FIELDS = createTenantPurgeOwnedVector<string>(1);
ID_FIELDS = pushTenantPurgeOwnedVector(ID_FIELDS, "id");

function safeFieldName(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1
    || value.length > MAXIMUM_FIELD_NAME_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = APPLY(CHAR_CODE_AT, value, [index]) as number;
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (!letter && code !== 95 && (index === 0 || code < 48 || code > 57)) return false;
  }
  return true;
}

function fieldSpec(fieldNames: TenantPurgeOwnedVector<string>): readonly string[] {
  const names = captureTenantPurgeOwnedVector<string>(fieldNames, MAXIMUM_FIELDS);
  if (names.length < 1) return invalid();
  for (let index = 0; index < names.length; index += 1) {
    if (!safeFieldName(names[index])) return invalid();
    for (let prior = 0; prior < index; prior += 1) {
      if (names[prior] === names[index]) return invalid();
    }
  }
  return names;
}

export function captureTenantPurgePrismaRowValues(
  value: unknown,
  fieldNames: TenantPurgeOwnedVector<string>,
): TenantPurgeOwnedVector<unknown> {
  const names = fieldSpec(fieldNames);
  if (value === null || typeof value !== "object"
    || observeTenantPurgeValue(() => ARRAY_IS_ARRAY(value))) return invalid();
  const prototype = observeTenantPurgeValue(() => GET_PROTOTYPE(value));
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) return invalid();
  let output = createTenantPurgeOwnedVector<unknown>(names.length);
  for (let index = 0; index < names.length; index += 1) {
    const descriptor = observeTenantPurgeValue(() => GET_DESCRIPTOR(value, names[index]));
    if (!descriptor || descriptor.enumerable !== true || !HAS_OWN(descriptor, "value")) return invalid();
    output = pushTenantPurgeOwnedVector(output, descriptor.value);
  }
  return output;
}

export function captureTenantPurgePrismaDateMilliseconds(value: unknown): number {
  if (value === null || typeof value !== "object") return invalid();
  const prototype = observeTenantPurgeValue(() => GET_PROTOTYPE(value));
  if (prototype !== DATE_PROTOTYPE) return invalid();
  const milliseconds = observeTenantPurgeValue(() => APPLY(DATE_GET_TIME, value, EMPTY));
  return typeof milliseconds === "number" && IS_SAFE_INTEGER(milliseconds) ? milliseconds : invalid();
}

export function captureTenantPurgePrismaClockMilliseconds(): number {
  const milliseconds = observeTenantPurgeValue(() => APPLY(DATE_NOW, DATE, EMPTY));
  return typeof milliseconds === "number" && IS_SAFE_INTEGER(milliseconds) ? milliseconds : invalid();
}

export function captureTenantPurgePrismaOrderedUuidVector(
  rows: unknown,
): TenantPurgeOwnedVector<string> {
  if (!observeTenantPurgeValue(() => ARRAY_IS_ARRAY(rows))) return invalid();
  if (observeTenantPurgeValue(() => GET_PROTOTYPE(rows as object)) !== ARRAY_PROTOTYPE) return invalid();
  const length = observeTenantPurgeValue(() => GET_DESCRIPTOR(rows as object, "length"));
  if (!length || length.enumerable !== false || length.configurable !== false
    || !HAS_OWN(length, "value") || !IS_SAFE_INTEGER(length.value)
    || (length.value as number) < 0 || (length.value as number) > MAXIMUM_ROWS) return invalid();
  let output = createTenantPurgeOwnedVector<string>(length.value as number);
  let previous: string | undefined;
  for (let index = 0; index < (length.value as number); index += 1) {
    const descriptor = observeTenantPurgeValue(() => GET_DESCRIPTOR(rows as object, STRING(index)));
    if (!descriptor || descriptor.enumerable !== true || !HAS_OWN(descriptor, "value")) return invalid();
    const values = captureTenantPurgeOwnedVector<unknown>(
      captureTenantPurgePrismaRowValues(descriptor.value, ID_FIELDS),
      1,
    );
    const id = copyTenantPurgeScalar(values[0], UUID_SPEC) as string;
    if (previous !== undefined && id <= previous) return invalid();
    output = pushTenantPurgeOwnedVector(output, id);
    previous = id;
  }
  return output;
}
