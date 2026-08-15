import { AppError } from "./errors";
import { prepareTenantPurgeManifestValues,
  type TenantPurgePreparedManifestValues } from "./tenant-purge-manifest-contract";
import { captureTenantPurgeRootFields } from "./tenant-purge-observation-kernel";
import type { TenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";
import { invalidTenantPurgeValue } from "./tenant-purge-value-scalar-kernel";
export type TenantPurgeAuthorizeAndCapture = () => Promise<false | TenantPurgeOwnedVector<unknown>>;
const APP_ERROR_PROTOTYPE = AppError.prototype;
const CREATE = Object.create;
const DEFINE = Object.defineProperty;
const FREEZE = Object.freeze;
const APPLY = Reflect.apply;
const CONSTRUCT = Reflect.construct;
const ERROR = Error;
const EMPTY = FREEZE([]);
const FORBIDDEN_ARGUMENTS = FREEZE(["Tenant purge target is forbidden."]);
function StableAppError() {}
StableAppError.prototype = APP_ERROR_PROTOTYPE;
function descriptor(value: unknown): PropertyDescriptor {
  const result = CREATE(null) as PropertyDescriptor;
  result.value = value; result.enumerable = true;
  result.configurable = true; result.writable = true;
  return result;
}
const AUTHORITY_SENTINEL = CREATE(null) as Record<string, unknown>;
DEFINE(AUTHORITY_SENTINEL, "privateAuthority", descriptor(false));
FREEZE(AUTHORITY_SENTINEL);
function targetForbidden(): never {
  const error = CONSTRUCT(ERROR, FORBIDDEN_ARGUMENTS, StableAppError) as AppError;
  DEFINE(error, "status", descriptor(403));
  DEFINE(error, "code", descriptor("TENANT_PURGE_TARGET_FORBIDDEN"));
  throw FREEZE(error);
}
/** The producer must authorize and capture its complete owned root atomically.
 * PR2B-1 owns the concrete transaction and race proof. */
export async function captureAuthorizedTenantPurgeManifestValues(
  privateAuthority: unknown, targetMode: unknown, authorizeAndCapture: unknown,
): Promise<TenantPurgePreparedManifestValues> {
  if (privateAuthority !== true) return captureTenantPurgeRootFields(AUTHORITY_SENTINEL) as never;
  const mode = targetMode === "ACCOUNT_WORKSPACE" ? targetMode
    : targetMode === "SELF_SERVE_TRIAL_WORKSPACE" ? targetMode : invalidTenantPurgeValue();
  const callback = authorizeAndCapture;
  if (typeof callback !== "function") return invalidTenantPurgeValue();
  let captured: unknown;
  try { captured = await APPLY(callback, undefined, EMPTY); } catch {
    return invalidTenantPurgeValue();
  }
  if (captured === false) return targetForbidden();
  return prepareTenantPurgeManifestValues(true, mode, captured);
}
