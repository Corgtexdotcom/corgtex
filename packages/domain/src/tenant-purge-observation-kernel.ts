import { AppError } from "./errors";

export interface TenantPurgeRawRootFields {
  readonly target: unknown;
  readonly capabilitySha: unknown;
  readonly redactionKey: unknown;
  readonly privateAuthority: true;
  readonly policies: unknown;
  readonly topology: unknown;
}

const APP_ERROR_PROTOTYPE = AppError.prototype;
const OBJECT_PROTOTYPE = Object.prototype;
const CREATE = Object.create;
const DEFINE_PROPERTY = Object.defineProperty;
const FREEZE = Object.freeze;
const GET_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const GET_PROTOTYPE = Object.getPrototypeOf;
const HAS_OWN = Object.hasOwn;
const APPLY = Reflect.apply;
const CONSTRUCT = Reflect.construct;
const OWN_KEYS = Reflect.ownKeys;
const ERROR = Error;
const REQUIRED_KEYS = FREEZE([
  "target", "capabilitySha", "redactionKey", "privateAuthority", "policies", "topology",
] as const);
const NO_ARGUMENTS = FREEZE([]);
const INVALID_MESSAGE = "Invalid tenant purge contract input.";
const AUTHORITY_MESSAGE = "Private tenant purge authority is required.";
const INVALID_ARGUMENTS = FREEZE([INVALID_MESSAGE]);
const AUTHORITY_ARGUMENTS = FREEZE([AUTHORITY_MESSAGE]);

function StableAppError() {}
StableAppError.prototype = APP_ERROR_PROTOTYPE;

function dataDescriptor(value: unknown, enumerable = true): PropertyDescriptor {
  const descriptor = CREATE(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.enumerable = enumerable;
  descriptor.configurable = true;
  descriptor.writable = true;
  return descriptor;
}

function fixedError(status: 400 | 403): never {
  const invalid = status === 400;
  const error = CONSTRUCT(ERROR, invalid ? INVALID_ARGUMENTS : AUTHORITY_ARGUMENTS, StableAppError) as AppError;
  DEFINE_PROPERTY(error, "status", dataDescriptor(status));
  DEFINE_PROPERTY(error, "code", dataDescriptor(invalid ? "TENANT_PURGE_CONTRACT_INVALID" : "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED"));
  throw FREEZE(error);
}

function observe<T>(operation: () => T): T {
  try {
    return APPLY(operation, undefined, NO_ARGUMENTS);
  } catch {
    return fixedError(400);
  }
}

function dataValue(descriptor: PropertyDescriptor | undefined): unknown | typeof ABSENT {
  return descriptor && descriptor.enumerable === true && HAS_OWN(descriptor, "value")
    ? descriptor.value
    : ABSENT;
}

function hasExactKeys(keys: readonly PropertyKey[]): boolean {
  if (keys.length !== REQUIRED_KEYS.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    let found = false;
    for (let required = 0; required < REQUIRED_KEYS.length; required += 1) {
      if (keys[index] === REQUIRED_KEYS[required]) found = true;
    }
    if (!found) return false;
  }
  return true;
}

const ABSENT = CREATE(null);

export function captureTenantPurgeRootFields(input: unknown): TenantPurgeRawRootFields {
  const authorityDescriptor = observe(() => GET_DESCRIPTOR(input as object, "privateAuthority"));
  const authority = dataValue(authorityDescriptor);
  if (authority !== true) return fixedError(403);

  const prototype = observe(() => GET_PROTOTYPE(input as object));
  const keys = observe(() => OWN_KEYS(input as object));
  if ((prototype !== OBJECT_PROTOTYPE && prototype !== null) || !hasExactKeys(keys)) return fixedError(400);

  const snapshot = CREATE(null) as Record<string, unknown>;
  DEFINE_PROPERTY(snapshot, "privateAuthority", dataDescriptor(true));
  for (let index = 0; index < REQUIRED_KEYS.length; index += 1) {
    const key = REQUIRED_KEYS[index];
    if (key === "privateAuthority") continue;
    const value = dataValue(observe(() => GET_DESCRIPTOR(input as object, key)));
    if (value === ABSENT) return fixedError(400);
    DEFINE_PROPERTY(snapshot, key, dataDescriptor(value));
  }
  return snapshot as unknown as TenantPurgeRawRootFields;
}
