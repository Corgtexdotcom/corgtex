import { invariant } from "./errors";
import type { SqlNativeDriver } from "./sql-ingestion-contract";
export type { SqlNativeDriver, SqlNativeDriverResult, SqlNativeDefinition,
  SqlNativeRow, SqlNativePage, SqlSourceConfiguration } from "./sql-ingestion-contract";

// Only dedicated server connector initialization registers an actual transport.
// Registration itself grants no claim, native receipt, or publication capability.
const drivers = new Map<string, SqlNativeDriver>();
export function registerSqlNativeDriver(driverType: "postgres", driver: SqlNativeDriver): void {
  invariant(driverType === "postgres" && typeof driver === "function", 409,
    "SQL_NATIVE_DRIVER_INVALID", "SQL native driver registration is invalid.");
  const existing = drivers.get(driverType);
  invariant(!existing || existing === driver, 409, "SQL_NATIVE_DRIVER_INVALID",
    "A different SQL native driver is already registered.");
  drivers.set(driverType, driver);
}
/** Internal authority lookup; returns a transport only. The claim/capture issuer
 * must load authoritative source/config and validate the opaque attempt itself. */
export function getRegisteredSqlNativeDriver(driverType: string): SqlNativeDriver {
  const driver = drivers.get(driverType);
  invariant(driver, 409, "SQL_NATIVE_DRIVER_UNAVAILABLE", "Authenticated SQL native driver is unavailable.");
  return driver;
}
