import { invalidTenantPurgeValue } from "./tenant-purge-value-scalar-kernel";

declare const TENANT_PURGE_OWNED_VECTOR: unique symbol;
export type TenantPurgeOwnedVector<T> = Readonly<{
  [TENANT_PURGE_OWNED_VECTOR]: T;
}>;

interface VectorState {
  readonly maximumLength: number;
  readonly length: number;
  readonly previous: object | null;
  readonly value: unknown;
}

const CREATE = Object.create;
const DEFINE_PROPERTY = Object.defineProperty;
const FREEZE = Object.freeze;
const SET_PROTOTYPE = Object.setPrototypeOf;
const APPLY = Reflect.apply;
const ARRAY = Array;
const IS_SAFE_INTEGER = Number.isSafeInteger;
const WEAK_MAP = WeakMap;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const MAXIMUM_LENGTH = 100_000;
const STATES = new WEAK_MAP<object, VectorState>();

function invalid(): never {
  return invalidTenantPurgeValue();
}

function validMaximum(maximumLength: number): boolean {
  return IS_SAFE_INTEGER(maximumLength)
    && maximumLength >= 0
    && maximumLength <= MAXIMUM_LENGTH;
}

function stateOf(vector: unknown): VectorState {
  const state = APPLY(WEAK_MAP_GET, STATES, [vector]) as VectorState | undefined;
  return state ?? invalid();
}

function register<T>(state: VectorState): TenantPurgeOwnedVector<T> {
  const handle = FREEZE(CREATE(null)) as TenantPurgeOwnedVector<T>;
  APPLY(WEAK_MAP_SET, STATES, [handle, FREEZE(state)]);
  return handle;
}

function dataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = CREATE(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  descriptor.writable = true;
  return descriptor;
}

export function createTenantPurgeOwnedVector<T>(
  maximumLength: number,
): TenantPurgeOwnedVector<T> {
  if (!validMaximum(maximumLength)) return invalid();
  return register<T>({ maximumLength, length: 0, previous: null, value: undefined });
}

export function pushTenantPurgeOwnedVector<T>(
  vector: unknown,
  value: T,
): TenantPurgeOwnedVector<T> {
  const state = stateOf(vector);
  if (state.length >= state.maximumLength) return invalid();
  return register<T>({
    maximumLength: state.maximumLength,
    length: state.length + 1,
    previous: vector as object,
    value,
  });
}

export function captureTenantPurgeOwnedVector<T>(
  vector: unknown,
  maximumLength: number,
): readonly T[] {
  if (!validMaximum(maximumLength)) return invalid();
  const head = stateOf(vector);
  if (head.length > maximumLength) return invalid();
  const output = new ARRAY<T>(head.length);
  SET_PROTOTYPE(output, null);
  let current = head;
  for (let index = head.length - 1; index >= 0; index -= 1) {
    if (current.length !== index + 1 || current.previous === null
      || current.maximumLength !== head.maximumLength) return invalid();
    DEFINE_PROPERTY(output, index, dataDescriptor(current.value));
    current = stateOf(current.previous);
  }
  if (current.length !== 0 || current.previous !== null
    || current.maximumLength !== head.maximumLength) return invalid();
  return FREEZE(output);
}
