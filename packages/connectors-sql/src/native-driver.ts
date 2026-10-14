import { registerSqlNativeDriver } from "@corgtex/domain/sql-native-driver";
import { capturePostgresScan } from "./native-scan";
import { validatePostgresNativeAccess } from "./native-access";

// Only this private transport is registered. Callers request capture using an
// opaque attempt; the domain authority supplies the actual source credentials.
registerSqlNativeDriver("postgres", async ({ source, assertCurrentSource }) => {
  return capturePostgresScan(source, assertCurrentSource);
}, { accessValidator: validatePostgresNativeAccess });
