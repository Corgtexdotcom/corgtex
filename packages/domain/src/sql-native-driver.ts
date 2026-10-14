import { invariant } from "./errors";
import type { SqlNativeDriver, SqlNativeAccessValidator } from "./sql-ingestion-contract";
export { renderSqlNativeRow } from "./sql-native-rendering";
export type { SqlNativeDriver, SqlNativeDriverResult, SqlNativeDefinition,
  SqlNativeRow, SqlNativePage, SqlSourceConfiguration, SqlNativeAccessValidator, SqlNativeCapturedColumn } from "./sql-ingestion-contract";

// Only dedicated server connector initialization registers an actual transport.
// Registration itself grants no claim, native receipt, or publication capability.
const drivers = new Map<string, SqlNativeDriver>();
const accessValidators = new Map<string, SqlNativeAccessValidator>();
export function registerSqlNativeDriver(driverType: "postgres", driver: SqlNativeDriver,
  options?: Readonly<{accessValidator: SqlNativeAccessValidator}>): void {
  invariant(driverType === "postgres" && typeof driver === "function", 409,
    "SQL_NATIVE_DRIVER_INVALID", "SQL native driver registration is invalid.");
  const existing = drivers.get(driverType);
  invariant(!existing || existing === driver, 409, "SQL_NATIVE_DRIVER_INVALID",
    "A different SQL native driver is already registered.");
  if (options) {
    const existingValidator = accessValidators.get(driverType);
    invariant(typeof options.accessValidator === "function" && (!existingValidator || existingValidator === options.accessValidator),
      409, "SQL_NATIVE_DRIVER_INVALID", "A different SQL native access validator is already registered.");
    accessValidators.set(driverType, options.accessValidator);
  }
  drivers.set(driverType, driver);
}
export function getRegisteredSqlNativeAccessValidator(driverType: string): SqlNativeAccessValidator {
  const validator = accessValidators.get(driverType);
  invariant(validator, 409, "SQL_NATIVE_ACCESS_UNAVAILABLE", "Authenticated current SQL native access is unavailable.");
  return validator;
}
/** Internal authority lookup; returns a transport only. The claim/capture issuer
 * must load authoritative source/config and validate the opaque attempt itself. */
export function getRegisteredSqlNativeDriver(driverType: string): SqlNativeDriver {
  const driver = drivers.get(driverType);
  invariant(driver, 409, "SQL_NATIVE_DRIVER_UNAVAILABLE", "Authenticated SQL native driver is unavailable.");
  return driver;
}
